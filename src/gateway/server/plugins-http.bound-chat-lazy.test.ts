import type { IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { createPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest } from "../../plugins/runtime.js";
import type { PluginRuntime } from "../../plugins/runtime/types.js";
import { createPluginRecord } from "../../plugins/status.test-helpers.js";
import type { GatewayRequestContext, GatewayRequestHandler } from "../server-methods/types.js";
import { makeMockHttpResponse } from "../test-http-response.js";
import { createGatewayPluginRequestHandler } from "./plugins-http.js";

const lazy = vi.hoisted(() => {
  let entered!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { entered, release, ready, barrier, effect: vi.fn() };
});
vi.mock("../server-methods/chat.js", async () => {
  lazy.entered();
  await lazy.barrier;
  return {
    chatHandlers: {
      "chat.send": (({ respond }) => {
        lazy.effect();
        respond(true, { status: "started" });
      }) satisfies GatewayRequestHandler,
    },
  };
});
afterEach(() => {
  resetPluginRuntimeStateForTest();
  vi.restoreAllMocks();
});

it("does not enter a resolved real handler when an unawaited submit outlives its HTTP handler", async () => {
  const declaration = { path: "/bound", agentId: "main", profile: "bound-chat-v1" as const };
  const registry = createPluginRegistry({
    runtime: {} as PluginRuntime,
    activateGlobalSideEffects: false,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    boundChatStartup: prepareBoundChatStartup({
      session: { store: path.join(os.tmpdir(), "bound-lazy-sessions.json") },
      agents: { list: [{ id: declaration.agentId }] },
      plugins: {
        entries: { example: { grants: { boundChat: [{ allow: true, ...declaration }] } } },
      },
    }),
  });
  const record = createPluginRecord({
    id: "example",
    contracts: { boundChat: [declaration.profile] },
  });
  let pending: Promise<unknown> | undefined;
  registry.createApi(record, { config: {} }).registerBoundChatRoute({
    path: declaration.path,
    agentId: "main",
    profile: "bound-chat-v1",
    authenticate: () => ({ authenticated: true, conversationKey: "c", operationKey: "o" }),
    handler: async (_req, _res, capability) => {
      pending = capability.submit({ message: "must not start" }).catch((error: unknown) => error);
      await lazy.ready; // Dispatch has crossed authorization but is blocked in real handler import.
      return true;
    },
  });
  const http = createGatewayPluginRequestHandler({
    registry: registry.registry,
    log: createSubsystemLogger("test/bound-chat"),
    getGatewayRequestContext: () => ({}) as GatewayRequestContext,
  });
  try {
    await http({ url: "/bound", headers: {} } as IncomingMessage, makeMockHttpResponse().res);
  } finally {
    lazy.release();
  }
  expect(await pending).toBeInstanceOf(Error);
  expect(lazy.effect).not.toHaveBeenCalled();
});
import { prepareBoundChatStartup } from "../../config/bound-chat.js";
