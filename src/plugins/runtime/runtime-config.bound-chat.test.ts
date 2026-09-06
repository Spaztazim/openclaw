import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../../config/config.js";
import { mutateConfigFile } from "../../config/mutate.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createRuntimeConfig } from "./runtime-config.js";

let root: string;
let file: string;
const grant = {
  allow: true as const,
  profile: "bound-chat-v1" as const,
  path: "/bound",
  agentId: "fixed",
};
const config = (): OpenClawConfig => ({
  agents: { list: [{ id: "fixed" }] },
  plugins: { enabled: false, entries: { example: { grants: { boundChat: [grant] } } } },
  logging: { level: "info" },
});
const afterWrite = { mode: "none" as const, reason: "test" };
const read = () => JSON.parse(fs.readFileSync(file, "utf8")) as OpenClawConfig;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "plugin-grant-io-")));
  file = path.join(root, "openclaw.json");
  vi.stubEnv("OPENCLAW_CONFIG_PATH", file);
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  vi.stubEnv("OPENCLAW_NIX_MODE", "0");
  fs.writeFileSync(file, JSON.stringify(config()));
  resetConfigRuntimeState();
  setRuntimeConfigSnapshot({});
});
afterEach(() => {
  resetConfigRuntimeState();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});
it.each(
  [
    [],
    ["plugins"],
    ["plugins", "entries"],
    ["plugins", "entries", "example"],
    ["plugins", "entries", "example", "grants"],
    ["plugins", "entries", "example", "grants", "boundChat"],
    ["plugins", "entries", "example", "grants", "boundChat", "0", "allow"],
  ].map((unset) => ({ unset })),
)("rejects protected unset $unset before callback/write", async ({ unset }) => {
  const before = fs.readFileSync(file, "utf8");
  const mutate = vi.fn();
  await expect(
    createRuntimeConfig().mutateConfigFile({
      afterWrite,
      writeOptions: { unsetPaths: [unset] },
      mutate,
    }),
  ).rejects.toThrow("operator-owned");
  expect(mutate).not.toHaveBeenCalled();
  expect(fs.readFileSync(file, "utf8")).toBe(before);
});
it.each(["replace", "deprecated", "mutate"])(
  "preserves newer locked disk grant with stale runtime: %s",
  async (mode) => {
    const newer = config();
    newer.plugins!.entries!.example.grants!.boundChat![0].path = "/newer";
    fs.writeFileSync(file, JSON.stringify(newer));
    const api = createRuntimeConfig();
    if (mode === "replace") {
      await api.replaceConfigFile({ nextConfig: { logging: { level: "debug" } }, afterWrite });
    } else if (mode === "deprecated") {
      await api.writeConfigFile({ logging: { level: "debug" } }, { afterWrite });
    } else {
      await api.mutateConfigFile({
        afterWrite,
        mutate: (draft) => {
          draft.logging = { level: "debug" };
        },
      });
    }
    expect(read().plugins?.entries?.example.grants).toEqual(newer.plugins!.entries!.example.grants);
  },
);
it("never exposes grants through retained draft/context/result/current or deprecated reads", async () => {
  setRuntimeConfigSnapshot(config());
  const api = createRuntimeConfig();
  expect(JSON.stringify([api.current(), api.loadConfig()])).not.toContain('"grants"');
  const result = await api.mutateConfigFile({
    afterWrite,
    mutate: (draft, context) => {
      expect(JSON.stringify([draft, context])).not.toContain('"grants"');
      draft.logging = { level: "debug" };
      return { draft, context };
    },
  });
  expect(JSON.stringify(result)).not.toContain('"grants"');
  expect(read().plugins?.entries?.example.grants).toEqual(
    config().plugins!.entries!.example.grants,
  );
});
it("preserves unrelated unset semantics", async () => {
  await createRuntimeConfig().mutateConfigFile({
    afterWrite,
    writeOptions: { unsetPaths: [["logging", "level"]] },
    mutate: () => {},
  });
  expect(read().logging?.level).toBeUndefined();
  expect(read().plugins?.entries?.example.grants).toBeDefined();
});
it.each(["mutate", "replace"])("rejects plugin-authored grant: %s", async (mode) => {
  const api = createRuntimeConfig();
  const action =
    mode === "replace"
      ? api.replaceConfigFile({ afterWrite, nextConfig: config() })
      : api.mutateConfigFile({
          afterWrite,
          mutate: (draft) => {
            draft.plugins = config().plugins;
          },
        });
  await expect(action).rejects.toThrow("operator-owned");
});
it.each([
  "explicitSetPaths",
  "explicitSetValueSource",
  "baseSnapshot",
  "preCommitRuntimePreflight",
  "ownedConfigPathForWrite",
])("rejects internal write option %s rather than forwarding a second write path", async (key) => {
  const before = fs.readFileSync(file, "utf8");
  await expect(
    createRuntimeConfig().mutateConfigFile({
      afterWrite,
      writeOptions: { [key]: key === "explicitSetPaths" ? [["plugins"]] : config() },
      mutate: () => {},
    }),
  ).rejects.toThrow();
  expect(fs.readFileSync(file, "utf8")).toBe(before);
});
it("serializes plugin replacement behind an in-flight operator mutation", async () => {
  let release!: () => void;
  let entered!: () => void;
  const inside = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const operator = mutateConfigFile({
    afterWrite,
    mutate: async (draft) => {
      entered();
      await blocked;
      draft.plugins!.entries!.example.grants!.boundChat![0].path = "/concurrent";
    },
  });
  await inside;
  const plugin = createRuntimeConfig().replaceConfigFile({
    afterWrite,
    nextConfig: { logging: { level: "debug" } },
  });
  release();
  await Promise.all([operator, plugin]);
  expect(read().plugins?.entries?.example.grants?.boundChat?.[0].path).toBe("/concurrent");
});
