/** Real history/store reads behind registry-issued capability; only submit terminal effect is stubbed. */
import fs from "node:fs";
import type { IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { prepareBoundChatStartup } from "../../config/bound-chat.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../../config/config.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getBoundChatClient } from "../../plugins/post-auth-chat.js";
import { createPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest } from "../../plugins/runtime.js";
import type { PluginRuntime } from "../../plugins/runtime/types.js";
import { createPluginRecord } from "../../plugins/status.test-helpers.js";
import * as managedImages from "../managed-image-attachments.js";
import { coreGatewayHandlers } from "../server-methods.js";
import { createGatewayPluginRequestHandler } from "../server/plugins-http.js";
import { makeMockHttpResponse } from "../test-http-response.js";
import type { GatewayRequestContext } from "./types.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  resetConfigRuntimeState();
  resetPluginRuntimeStateForTest();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
it.each(["runtime", "parent", "file"])(
  "bound-chat physical store remains fixed across %s drift without global image cleanup",
  async (kind) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bound-chat-store-")));
    roots.push(root);
    const storeA = path.join(root, "a", "sessions.json"),
      storeB = path.join(root, "b", "sessions.json");
    fs.mkdirSync(path.dirname(storeA));
    fs.mkdirSync(path.dirname(storeB));
    fs.writeFileSync(storeA, "{}");
    fs.writeFileSync(storeB, "{}");
    const link = path.join(root, "link");
    const target = (store: string) => (kind === "parent" ? path.dirname(store) : store);
    if (kind !== "runtime") {
      fs.symlinkSync(target(storeA), link, kind === "parent" ? "junction" : "file");
    }
    const initialStore =
      kind === "runtime" ? storeA : kind === "parent" ? path.join(link, "sessions.json") : link;
    const cleanup = vi.spyOn(managedImages, "cleanupManagedOutgoingImageRecords");
    const route = { path: "/bound", agentId: "fixed", profile: "bound-chat-v1" as const };
    const config = (store: string): OpenClawConfig => ({
      session: { store },
      agents: { list: [{ id: "fixed" }] },
      plugins: { entries: { example: { grants: { boundChat: [{ allow: true, ...route }] } } } },
    });
    let sessionKey = "";
    vi.spyOn(coreGatewayHandlers, "chat.send").mockImplementation(
      async ({ params, client, respond }) => {
        expect([storeA, storeB]).toContain(getBoundChatClient(client)?.grant.config.session?.store);
        sessionKey = String(params.sessionKey);
        respond(true, { runId: params.idempotencyKey });
      },
    );
    const context = {
      getRuntimeConfig: () => config(storeB),
      loadGatewayModelCatalog: async () => [],
      chatAbortControllers: new Map(),
      chatRunBuffers: new Map(),
      chatQueuedTurns: new Map(),
      chatAbortedRuns: new Map(),
      dedupe: new Map(),
      logGateway: { debug() {}, warn() {}, error() {} },
    } as unknown as GatewayRequestContext;
    const invoke = async (store: string, seed = false) => {
      const startupConfig = config(store);
      const startup = prepareBoundChatStartup(startupConfig);
      expect(Object.isFrozen(startup.grants)).toBe(true);
      expect(Object.isFrozen(startup.grants[0]?.config.session)).toBe(true);
      const registry = createPluginRegistry({
        runtime: {} as PluginRuntime,
        logger: { info() {}, warn() {}, error() {}, debug() {} },
        activateGlobalSideEffects: false,
        boundChatStartup: startup,
      });
      const record = createPluginRecord({
        id: "example",
        contracts: { boundChat: [route.profile] },
      });
      let result: unknown;
      registry.createApi(record, { config: startupConfig }).registerBoundChatRoute({
        ...route,
        authenticate: () => ({
          authenticated: true,
          conversationKey: "same",
          operationKey: "same",
        }),
        handler: async (_req, _res, cap) => {
          await cap.submit({ message: "namespace probe" });
          if (seed) {
            await replaceSessionEntry(
              { storePath: storeA, agentId: "fixed", sessionKey },
              { sessionId: "store-a", updatedAt: 1 },
            );
            await replaceSessionEntry(
              { storePath: storeB, agentId: "fixed", sessionKey },
              { sessionId: "store-b-unrelated", updatedAt: 1 },
            );
            if (kind !== "runtime") {
              fs.unlinkSync(link);
              fs.symlinkSync(target(storeB), link, kind === "parent" ? "junction" : "file");
            }
          }
          // Neither a changed live config nor mutation of the original startup object retargets it.
          startupConfig.session!.store = storeB;
          setRuntimeConfigSnapshot(config(storeB));
          result = await cap.read();
        },
      });
      const http = createGatewayPluginRequestHandler({
        registry: registry.registry,
        log: createSubsystemLogger("test/bound-store"),
        getGatewayRequestContext: () => context,
      });
      await http({ url: route.path, headers: {} } as IncomingMessage, makeMockHttpResponse().res);
      return { key: sessionKey, result };
    };
    const a = await invoke(initialStore, true);
    expect(a.result).toMatchObject({ ok: true, payload: { sessionId: "store-a" } });
    const unchanged = await invoke(storeA);
    expect(unchanged.key).toBe(a.key);
    expect(unchanged.result).toMatchObject({ ok: true, payload: { sessionId: "store-a" } });
    const b = await invoke(storeB);
    expect(b.key).not.toBe(a.key);
    expect(b.result).toMatchObject({ ok: true, payload: { messages: [] } });
    expect(JSON.stringify(b.result)).not.toContain("store-b-unrelated");
    expect(JSON.stringify([a.result, b.result])).not.toContain(root);
    expect(cleanup).not.toHaveBeenCalled();
    await coreGatewayHandlers["chat.history"]({
      client: null,
      context,
      params: { sessionKey: b.key },
      req: { type: "req", id: "ordinary", method: "chat.history" },
      respond: vi.fn(),
      isWebchatConnect: () => false,
    });
    expect(cleanup).toHaveBeenCalled();
  },
);
