/** Cold-start operator authority; shared transactional hot replacement is not a contract. */
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, expect, it } from "vitest";
import { prepareBoundChatStartup } from "../config/bound-chat.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { OpenClawSchema } from "../config/zod-schema.js";
import { prepareGatewayPluginLoad } from "../gateway/server-plugin-bootstrap.js";
import { loadGatewayStartupPluginRuntime } from "../gateway/server-startup-plugins.js";
import { loadOpenClawPlugins, loadOpenClawPluginCliRegistry } from "./loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "./loader.test-fixtures.js";

const logger = { info() {}, warn() {}, error() {}, debug() {} };
const grant = {
  allow: true,
  profile: "bound-chat-v1",
  path: "/bound-chat",
  agentId: "fixed-agent",
};
afterEach(resetPluginLoaderTestStateForTest);
afterAll(cleanupPluginLoaderFixturesForTest);
function fixture(value: unknown, agents: unknown = [{ id: "fixed-agent" }], manifest = true) {
  useNoBundledPlugins();
  const plugin = writePlugin({
    id: "owner-probe",
    body: `module.exports = { id: "owner-probe", register(api) {
    if (Object.values(api.config.plugins.entries).some(entry => entry.grants !== undefined)) throw new Error("operator grants exposed");
    api.registerBoundChatRoute({ path: "/bound-chat", agentId: "fixed-agent", profile: "bound-chat-v1", authenticate: () => false, handler: () => true });
  } };`,
  });
  fs.writeFileSync(
    path.join(plugin.dir, "openclaw.plugin.json"),
    JSON.stringify({
      id: plugin.id,
      configSchema: { type: "object" },
      ...(manifest ? { contracts: { boundChat: ["bound-chat-v1"] } } : {}),
    }),
  );
  const config = {
    session: { store: path.join(plugin.dir, "sessions.json") },
    agents: { list: agents },
    plugins: {
      enabled: true,
      allow: [plugin.id],
      load: { paths: [plugin.file] },
      entries: {
        [plugin.id]: {
          enabled: true,
          ...(value === undefined ? {} : { grants: { boundChat: value } }),
        },
      },
    },
  } as OpenClawConfig;
  const startup = prepareBoundChatStartup(config);
  return {
    config,
    startup,
    load: () => loadOpenClawPlugins({ config, boundChatStartup: startup, cache: false, logger }),
  };
}
it("accepts exact operator config and loads a bound route without exposing grants", () => {
  const { config, load } = fixture([grant]);
  expect(OpenClawSchema.safeParse(config).success).toBe(true);
  const registry = load();
  expect(registry.plugins[0]?.status).toBe("loaded");
  expect(registry.httpRoutes.map((route) => route.path)).toEqual([grant.path]);
});
it("CLI metadata never exposes any entry's grants", async () => {
  const { config } = fixture([grant]);
  const registry = await loadOpenClawPluginCliRegistry({ config, cache: false, logger });
  expect(registry.plugins[0]?.status).toBe("loaded");
  expect(config.plugins?.entries?.["owner-probe"].grants).toBeDefined();
});
it("a generic scoped load before Gateway startup has zero authority", () => {
  const { config } = fixture([grant]);
  expect(
    loadOpenClawPlugins({ config, onlyPluginIds: ["owner-probe"], logger }).httpRoutes,
  ).toEqual([]);
});
it.each(
  [
    undefined,
    [],
    [{ ...grant, allow: false }],
    [{ ...grant, allow: "true" }],
    [null],
    ["bound-chat-v1"],
    [{ ...grant, pluginId: "owner-probe" }],
    [{ ...grant, scopes: ["operator.admin"] }],
    [{ ...grant, path: "/*" }],
    [{ ...grant, path: "/bound-chat/" }],
    [{ ...grant, profile: "future-profile" }],
    [{ ...grant, agentId: "main" }],
    [{ ...grant, agentId: "missing" }],
    [grant, { ...grant, allow: false }],
  ].map((value) => ({ value })),
)("denies incomplete or invalid cold-start grant set $value", ({ value }) => {
  const { load } = fixture(value);
  const registry = load();
  expect(registry.httpRoutes).toEqual([]);
  expect(
    registry.diagnostics.some((d) => d.level === "error" && d.message.includes("bound chat")),
  ).toBe(true);
});
it("denies implicit main and requires explicit agent membership", () => {
  expect(fixture([grant], []).load().httpRoutes).toEqual([]);
});
it("denies registration without the manifest profile", () => {
  expect(fixture([grant], undefined, false).load().httpRoutes).toEqual([]);
});
it("does not change instance startup grants on hot reload; restart requires a new owner, not global reset", () => {
  const { config, load } = fixture([grant]);
  expect(load().httpRoutes).toHaveLength(1);
  delete config.plugins!.entries!["owner-probe"].grants;
  expect(load().httpRoutes).toHaveLength(1);
  expect(
    loadOpenClawPlugins({ config, boundChatStartup: prepareBoundChatStartup(config), logger })
      .httpRoutes,
  ).toEqual([]);
});
it("scoped-before-full and interleaved Gateway/profile owners cannot poison or inherit authority", async () => {
  const { config, startup } = fixture([grant]);
  const workspaceDir = path.dirname(config.session!.store!);
  const options = {
    cfg: config,
    workspaceDir,
    log: logger,
    baseMethods: [],
    startupPluginIds: ["owner-probe"],
  };
  const generic = () => loadOpenClawPlugins({ config, onlyPluginIds: ["owner-probe"], logger });
  expect(generic().httpRoutes).toEqual([]);
  const a = await loadGatewayStartupPluginRuntime({ ...options, boundChatStartup: startup });
  expect(a.pluginRegistry.httpRoutes).toHaveLength(1);
  expect(generic().httpRoutes).toEqual([]);
  const configB = structuredClone(config);
  delete configB.plugins!.entries!["owner-probe"].grants;
  configB.session!.store = path.join(workspaceDir, "profile-b.json");
  const ownerB = prepareBoundChatStartup(configB);
  const b = await loadGatewayStartupPluginRuntime({
    ...options,
    cfg: configB,
    boundChatStartup: ownerB,
  });
  expect(b.pluginRegistry.httpRoutes).toEqual([]);
  const hotA = prepareGatewayPluginLoad({
    ...options,
    cfg: configB,
    pluginIds: ["owner-probe"],
    boundChatStartup: startup,
  });
  expect(hotA.pluginRegistry.httpRoutes).toHaveLength(1);
  expect(startup.grants[0]?.config.session?.store).toBe(config.session!.store);
  const restartedA = await loadGatewayStartupPluginRuntime({
    ...options,
    cfg: configB,
    boundChatStartup: prepareBoundChatStartup(configB),
  });
  expect(restartedA.pluginRegistry.httpRoutes).toEqual([]);
  expect(generic().httpRoutes).toEqual([]);
});
