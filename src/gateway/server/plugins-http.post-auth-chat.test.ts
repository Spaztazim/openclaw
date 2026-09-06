/** Real registry -> HTTP dispatcher -> Gateway authorization; only method effects are stubbed. */
import type { IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareBoundChatStartup } from "../../config/bound-chat.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { OpenClawPluginApi } from "../../plugin-sdk/core.js";
type PluginPostAuthChatRoute = Parameters<OpenClawPluginApi["registerBoundChatRoute"]>[0];
type PluginPostAuthChatCapability = Parameters<PluginPostAuthChatRoute["handler"]>[2];
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { dispatchGatewayMethod } from "../../plugin-sdk/gateway-method-runtime.js";
import { createPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import type { PluginRuntime } from "../../plugins/runtime/types.js";
import { createPluginRecord } from "../../plugins/status.test-helpers.js";
import { coreGatewayHandlers } from "../server-methods.js";
import type { GatewayRequestContext } from "../server-methods/types.js";
import { makeMockHttpResponse } from "../test-http-response.js";
import { createGatewayPluginRequestHandler } from "./plugins-http.js";

const binding = { path: "/bound-chat", agentId: "bound-agent", profile: "bound-chat-v1" as const };
const positive = {
  authenticated: true as const,
  conversationKey: "conversation",
  operationKey: "operation",
};

function harness(
  options: {
    grant?: boolean;
    manifest?: boolean;
    profiles?: string[];
    startupConfig?: OpenClawConfig;
    grantOverride?: Partial<Record<"pluginId" | "path" | "agentId" | "profile", string>>;
  } = {},
) {
  const effects: Array<{ method: string; params: Record<string, unknown>; scopes: string[] }> = [];
  for (const method of ["chat.send", "agent.wait", "chat.history"]) {
    vi.spyOn(coreGatewayHandlers, method).mockImplementation(
      async ({ params, client, respond }) => {
        effects.push({ method, params, scopes: client?.connect.scopes ?? [] });
        respond(
          true,
          method === "chat.send"
            ? { runId: params.idempotencyKey, status: "started" }
            : { status: "ok", messages: [] },
        );
      },
    );
  }
  const registry = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: {} as PluginRuntime,
    activateGlobalSideEffects: false,
    boundChatStartup: prepareBoundChatStartup({
      agents: { list: [{ id: binding.agentId }] },
      session: { store: path.join(os.tmpdir(), "bound-http-sessions.json") },
      ...options.startupConfig,
      plugins: {
        entries: {
          [options.grantOverride?.pluginId ?? "example"]: {
            grants: {
              boundChat:
                options.grant === false
                  ? []
                  : [
                      {
                        allow: true,
                        ...binding,
                        path: options.grantOverride?.path ?? binding.path,
                        agentId: options.grantOverride?.agentId ?? binding.agentId,
                        profile: (options.grantOverride?.profile ??
                          binding.profile) as typeof binding.profile,
                      },
                    ],
            },
          },
        },
      },
    }),
  });
  const record = createPluginRecord({
    id: "example",
    contracts: {
      gatewayMethodDispatch: ["authenticated-request"],
      ...(options.manifest === false ? {} : { boundChat: options.profiles ?? [binding.profile] }),
    },
  });
  registry.registry.plugins.push(record);
  const api = registry.createApi(record, { config: {} });
  const register = (boundChat: PluginPostAuthChatRoute) => api.registerBoundChatRoute(boundChat);
  const http = createGatewayPluginRequestHandler({
    registry: registry.registry,
    getRouteRegistry: () => registry.registry,
    log: createSubsystemLogger("test/post-auth-chat"),
    getGatewayRequestContext: () => ({}) as GatewayRequestContext,
  });
  const request = async (authorization?: string) => {
    const response = makeMockHttpResponse();
    await http(
      { url: binding.path, headers: { authorization } } as IncomingMessage,
      response.res,
      undefined,
      { gatewayAuthSatisfied: true, gatewayRequestOperatorScopes: ["operator.admin"] },
    );
    return response;
  };
  return { effects, register, request, registry, api };
}

function route(overrides: Partial<PluginPostAuthChatRoute> = {}): PluginPostAuthChatRoute {
  return {
    path: binding.path,
    agentId: binding.agentId,
    profile: binding.profile,
    authenticate: (req) => (req.headers.authorization === "test-positive" ? positive : false),
    handler: async (_req, _res, capability) => {
      await capability.submit({ message: "hello" });
      await capability.wait({ timeoutMs: 0 });
      await capability.read({ limit: 10 });
      return true;
    },
    ...overrides,
  };
}

it.each([
  { session: { store: path.join(os.tmpdir(), "bound-store-b.json") } },
  { session: { store: path.join(os.tmpdir(), "bound-store-a.json"), scope: "global" as const } },
  { session: { store: path.join(os.tmpdir(), "bound-store-a.json"), mainKey: "other" } },
  {
    agents: { list: [{ id: "other", default: true }, { id: binding.agentId }] },
    session: { store: path.join(os.tmpdir(), "bound-store-a.json") },
  },
])("startup binding changes namespace without leaking paths: %j", async (changed) => {
  const run = async (startupConfig: OpenClawConfig) => {
    const h = harness({ startupConfig });
    h.register(route());
    await h.request("test-positive");
    return h.effects.map((effect) => effect.params);
  };
  const a = await run({ session: { store: path.join(os.tmpdir(), "bound-store-a.json") } });
  const same = await run({ session: { store: path.join(os.tmpdir(), "bound-store-a.json") } });
  const b = await run(changed);
  expect(same).toEqual(a);
  expect(b[0]?.sessionKey).not.toEqual(a[0]?.sessionKey);
  expect(b[0]?.idempotencyKey).not.toEqual(a[0]?.idempotencyKey);
  expect(JSON.stringify([a, b])).not.toContain("/private/");
});

it.each(["throw", "response"])("sanitizes bound operation I/O failure: %s", async (mode) => {
  const h = harness();
  vi.spyOn(coreGatewayHandlers, "chat.history").mockImplementation(async ({ respond }) => {
    if (mode === "throw") {
      throw new Error("EACCES /private/pinned-store/sessions.json");
    }
    respond(
      false,
      { path: "/private/pinned-store" },
      {
        code: "UNAVAILABLE",
        message: "EIO /private/pinned-store",
        details: { path: "/private/pinned-store" },
      },
    );
  });
  let receipt: unknown;
  h.register(
    route({
      handler: async (_req, _res, cap) => {
        try {
          receipt = await cap.read();
        } catch (error) {
          receipt = { message: String(error) };
        }
      },
    }),
  );
  await h.request("test-positive");
  expect(JSON.stringify(receipt)).not.toContain("/private/");
  expect(JSON.stringify(receipt)).toContain("bound chat operation failed");
});

afterEach(() => {
  vi.restoreAllMocks();
  resetPluginRuntimeStateForTest();
});

describe("post-plugin-auth bound chat v1", () => {
  it("adds a separate bound route API without changing ordinary handler registration", () => {
    const h = harness();
    expect(h.api).toHaveProperty("registerBoundChatRoute", expect.any(Function));
    const handler: import("../../plugins/types.js").OpenClawPluginHttpRouteParams["handler"] = () =>
      true;
    h.api.registerHttpRoute({ path: "/ordinary", auth: "plugin", handler });
    expect(h.registry.registry.httpRoutes[0].handler).toBe(handler);
  });
  it("keeps [] ambient scopes and denies generic dispatch before and after positive authentication", async () => {
    const h = harness();
    const observed: unknown[] = [];
    const check = async () => {
      observed.push(getPluginRuntimeGatewayRequestScope()?.client?.connect.scopes);
      const result = await dispatchGatewayMethod("chat.send", {});
      expect(result).toMatchObject({
        ok: false,
        error: { message: "missing scope: operator.write" },
      });
    };
    h.register(
      route({
        authenticate: async () => {
          await check();
          return positive;
        },
        handler: async (_req, _res, capability) => {
          await check();
          await capability.submit({ message: "hello" });
          return true;
        },
      }),
    );
    const response = await h.request("test-positive");
    expect(response.res.statusCode).toBe(200);
    expect(observed).toEqual([[], []]);
    expect(h.effects.map((e) => e.method)).toEqual(["chat.send"]);
  });

  it.each([undefined, "bad", "parser-failure", "replay-failure", "throw"])(
    "mints zero authority for %s",
    async (auth) => {
      const h = harness();
      const authorized = vi.fn();
      let authenticationCalls = 0;
      h.register(
        route({
          authenticate: (req) => {
            authenticationCalls++;
            if (req.headers.authorization === "throw") {
              throw new Error("auth failed");
            }
            if (req.headers.authorization === "parser-failure") {
              JSON.parse("{");
            }
            return false;
          },
          handler: authorized,
        }),
      );
      const response = await h.request(auth);
      expect(authenticationCalls).toBe(1);
      expect(response.res.statusCode).toBe(
        auth === "throw" || auth === "parser-failure" ? 500 : 401,
      );
      expect(authorized).not.toHaveBeenCalled();
      expect(h.effects).toEqual([]);
    },
  );

  it("submits, waits and reads only the bound target with exact write/read scopes", async () => {
    const h = harness();
    h.register(route());
    const response = await h.request("test-positive");
    expect(response.res.statusCode).toBe(200);
    expect(h.effects.map((e) => [e.method, e.scopes])).toEqual([
      ["chat.send", ["operator.write"]],
      ["agent.wait", ["operator.write"]],
      ["chat.history", ["operator.read"]],
    ]);
    const [send, wait, read] = h.effects;
    expect(send.params).toMatchObject({
      agentId: binding.agentId,
      deliver: false,
      message: "hello",
    });
    expect(send.params.sessionKey).toMatch(/^agent:bound-agent:plugin-chat:/);
    expect(wait.params.runId).toBe(send.params.idempotencyKey);
    expect(read.params.sessionKey).toBe(send.params.sessionKey);
    expect(read.params.agentId).toBe(binding.agentId);
  });

  it.each([{ grant: false }, { manifest: false }])(
    "requires declaration AND runtime-owned grant: %j",
    async (options) => {
      const h = harness(options);
      const authorized = vi.fn();
      h.register(route({ handler: authorized }));
      await h.request("test-positive");
      expect(authorized).not.toHaveBeenCalled();
      expect(h.effects).toEqual([]);
      expect(h.registry.registry.httpRoutes).toHaveLength(0);
      expect(h.registry.registry.diagnostics.some((d) => d.message.includes("bound chat"))).toBe(
        true,
      );
    },
  );

  it.each([
    { profiles: ["future-profile"] },
    { profiles: [] },
    { grantOverride: { pluginId: "other" } },
    { grantOverride: { path: "/other" } },
    { grantOverride: { agentId: "other" } },
    { grantOverride: { profile: "future-profile" } },
  ])("profile metadata cannot replace the exact operator grant: %j", async (options) => {
    const h = harness(options);
    const authorized = vi.fn();
    h.register(route({ handler: authorized }));
    await h.request("test-positive");
    expect(h.registry.registry.httpRoutes).toHaveLength(0);
    expect(authorized).not.toHaveBeenCalled();
    expect(h.effects).toEqual([]);
  });

  it("allows a declared supported profile with an exact grant despite inert future metadata", async () => {
    const h = harness({ profiles: ["future-profile", binding.profile] });
    h.register(route());
    await h.request("test-positive");
    expect(h.effects.map((effect) => effect.method)).toEqual([
      "chat.send",
      "agent.wait",
      "chat.history",
    ]);
  });

  it("rejects an unsupported runtime profile even when metadata and a grant name it", async () => {
    const h = harness({
      profiles: ["future-profile"],
      grantOverride: { profile: "future-profile" },
    });
    h.register(route({ profile: "future-profile" as typeof binding.profile }));
    await h.request("test-positive");
    expect(h.registry.registry.httpRoutes).toHaveLength(0);
    expect(h.effects).toEqual([]);
  });

  it("rejects alternate methods and all target/authority overrides at runtime", async () => {
    const h = harness();
    let checked = false;
    h.register(
      route({
        handler: async (_req, _res, capability) => {
          expect(Object.keys(capability).toSorted()).toEqual(["read", "submit", "wait"]);
          expect(() => JSON.stringify(capability)).toThrow();
          expect(() => structuredClone(capability)).toThrow();
          expect(Object.isFrozen(capability)).toBe(true);
          for (const key of [
            "method",
            "agentId",
            "sessionKey",
            "sessionId",
            "model",
            "tools",
            "deliver",
            "originatingTo",
            "scopes",
            "forceSyntheticClient",
            "idempotencyKey",
          ]) {
            await expect(
              capability.submit({ message: "hello", [key]: "hostile" }),
            ).rejects.toThrow();
            await expect(capability.wait({ [key]: "hostile" })).rejects.toThrow();
            await expect(capability.read({ [key]: "hostile" })).rejects.toThrow();
          }
          checked = true;
          return true;
        },
      }),
    );
    expect((await h.request("test-positive")).res.statusCode).toBe(200);
    expect(checked).toBe(true);
    expect(h.effects).toEqual([]);
  });

  it("rejects a still-live stolen capability from another request and another plugin route", async () => {
    const h = harness();
    let retained: PluginPostAuthChatCapability | undefined;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let rejected = false;
    h.register(
      route({
        handler: async (_req, _res, capability) => {
          if (!retained) {
            retained = capability;
            entered();
            await barrier;
          } else {
            await expect(retained.submit({ message: "stolen" })).rejects.toThrow("inactive");
            rejected = true;
          }
          return true;
        },
      }),
    );
    const first = h.request("test-positive");
    await Promise.race([ready, first]);
    expect(retained).toBeDefined();
    try {
      expect((await h.request("test-positive")).res.statusCode).toBe(200);
      const other = createPluginRecord({ id: "other" });
      h.registry.createApi(other, { config: {} }).registerHttpRoute({
        path: "/other",
        auth: "plugin",
        handler: async () => {
          await expect(retained!.read()).rejects.toThrow("inactive");
          return true;
        },
      });
      const http = createGatewayPluginRequestHandler({
        registry: h.registry.registry,
        log: createSubsystemLogger("test/post-auth-chat"),
        getGatewayRequestContext: () => ({}) as GatewayRequestContext,
      });
      const response = makeMockHttpResponse();
      await http({ url: "/other", headers: {} } as IncomingMessage, response.res);
      expect(response.res.statusCode).toBe(200);
      expect(rejected).toBe(true);
    } finally {
      release();
      await first;
    }
    expect(h.effects).toEqual([]);
  });

  it("rejects route replacement during authentication and stale active generations", async () => {
    const h = harness();
    const replacement = route({ handler: vi.fn() });
    h.register(
      route({
        authenticate: () => {
          h.register(replacement);
          return positive;
        },
      }),
    );
    expect((await h.request("test-positive")).res.statusCode).toBe(500);
    let checked = false;
    h.register(
      route({
        handler: async (_req, _res, capability) => {
          h.register(replacement);
          await expect(capability.submit({ message: "stale" })).rejects.toThrow("inactive");
          checked = true;
          return true;
        },
      }),
    );
    await h.request("test-positive");
    expect(checked).toBe(true);
    expect(h.effects).toEqual([]);
  });

  it("keeps binding stable for reauthenticated uncertainty recovery, not caller-selected run/session IDs", async () => {
    const h = harness();
    h.register(route());
    await h.request("test-positive");
    await h.request("test-positive");
    expect(h.effects).toHaveLength(6);
    expect(h.effects[3].params).toEqual(h.effects[0].params);
    expect(h.effects[4].params).toEqual(h.effects[1].params);
  });

  it("forwards the existing 20 MiB decoded attachment shape in process beyond the 25 MiB WS frame limit", async () => {
    const h = harness();
    const content = Buffer.alloc(20 * 1024 * 1024, 0x61).toString("base64");
    const attachments = [{ type: "file", mimeType: "text/plain", fileName: "large.txt", content }];
    expect(Buffer.byteLength(JSON.stringify(attachments))).toBeGreaterThan(25 * 1024 * 1024);
    h.register(
      route({
        handler: async (_req, _res, capability) => {
          await capability.submit({ message: "attachment", attachments });
          return true;
        },
      }),
    );
    expect((await h.request("test-positive")).res.statusCode).toBe(200);
    expect(h.effects).toHaveLength(1);
    expect(h.effects[0].params.attachments).toEqual(attachments);
  });

  it.each([
    true,
    null,
    { authenticated: true },
    { ...positive, conversationKey: "" },
    { ...positive, operationKey: "" },
    { ...positive, extra: true },
    Object.defineProperty({ ...positive }, "authenticated", { get: () => true }),
    new Proxy({ ...positive }, {}),
  ])("rejects malformed positive auth without capability/effects: %j", async (result) => {
    const h = harness();
    const authorized = vi.fn();
    h.register(route({ authenticate: () => result as typeof positive, handler: authorized }));
    expect((await h.request()).res.statusCode).toBe(401);
    expect(authorized).not.toHaveBeenCalled();
    expect(h.effects).toEqual([]);
  });

  it.each(["/Bound", "/bound//chat", "/bound/", "/%62ound"])(
    "rejects noncanonical declarations and grants: %s",
    (routePath) => {
      const declaration = { ...binding, path: routePath };
      const registry = createPluginRegistry({
        runtime: {} as PluginRuntime,
        logger: { info() {}, warn() {}, error() {}, debug() {} },
        activateGlobalSideEffects: false,
        boundChatStartup: prepareBoundChatStartup({
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
      registry.createApi(record, { config: {} }).registerBoundChatRoute(route({ path: routePath }));
      expect(registry.registry.httpRoutes).toHaveLength(0);
    },
  );

  it.each(["/BOUND-CHAT", "/bound-chat//", "/%62ound-chat", "/bound-chat/../bound-chat", "/"])(
    "rejects canonical neighbors in either registration order: %s",
    (routePath) => {
      for (const boundFirst of [true, false]) {
        const h = harness();
        const ordinary = () =>
          h.api.registerHttpRoute({
            path: routePath,
            auth: "plugin",
            match: routePath === "/" ? "prefix" : "exact",
            handler: () => true,
          });
        if (boundFirst) {
          h.register(route());
          ordinary();
        } else {
          ordinary();
          h.register(route());
        }
        expect(h.registry.registry.httpRoutes).toHaveLength(1);
      }
    },
  );

  it("claims an authenticated request even if the authorized handler returns false", async () => {
    const h = harness();
    h.register(route({ handler: () => false }));
    const http = createGatewayPluginRequestHandler({
      registry: h.registry.registry,
      log: createSubsystemLogger("test/bound-chat"),
      getGatewayRequestContext: () => ({}) as GatewayRequestContext,
    });
    expect(
      await http(
        { url: binding.path, headers: { authorization: "test-positive" } } as IncomingMessage,
        makeMockHttpResponse().res,
      ),
    ).toBe(true);
  });

  it("does not reread an accessor declaration after grant validation", async () => {
    const h = harness();
    let reads = 0;
    const input = route();
    Object.defineProperty(input, "agentId", {
      get: () => (++reads <= 3 ? binding.agentId : "unapproved"),
    });
    h.register(input);
    await h.request("test-positive");
    expect(
      h.effects.every(
        (effect) =>
          effect.params.agentId === undefined || effect.params.agentId === binding.agentId,
      ),
    ).toBe(true);
    expect(reads).toBeLessThanOrEqual(1);
  });

  it.each(["end", "disconnect", "reload"])("revokes before use on %s", async (event) => {
    const h = harness();
    setActivePluginRegistry(h.registry.registry);
    let checked = false;
    h.register(
      route({
        handler: async (_req, res, capability) => {
          if (event === "end") {
            res.end();
          } else if (event === "disconnect") {
            res.emit("close");
          } else {
            setActivePluginRegistry(
              createPluginRegistry({
                runtime: {} as PluginRuntime,
                logger: { info() {}, warn() {}, error() {}, debug() {} },
                activateGlobalSideEffects: false,
              }).registry,
            );
          }
          for (const operation of [
            () => capability.submit({ message: "late" }),
            () => capability.wait(),
            () => capability.read(),
          ]) {
            await expect(operation()).rejects.toThrow("inactive");
          }
          checked = true;
          return true;
        },
      }),
    );
    await h.request("test-positive");
    expect(checked).toBe(true);
    expect(h.effects).toEqual([]);
  });

  it("does not revive an issued capability when a retired registry object is reactivated", async () => {
    const h = harness();
    setActivePluginRegistry(h.registry.registry);
    let checked = false;
    h.register(
      route({
        handler: async (_req, _res, capability) => {
          const next = createPluginRegistry({
            runtime: {} as PluginRuntime,
            activateGlobalSideEffects: false,
            logger: { info() {}, warn() {}, error() {}, debug() {} },
          });
          setActivePluginRegistry(next.registry);
          setActivePluginRegistry(h.registry.registry);
          await expect(capability.submit({ message: "old invocation" })).rejects.toThrow(
            "inactive",
          );
          checked = true;
          return true;
        },
      }),
    );
    await h.request("test-positive");
    expect(checked).toBe(true);
    expect(h.effects).toEqual([]);
  });

  it("revokes retained capabilities on completion and handler exception", async () => {
    const h = harness();
    const retained: PluginPostAuthChatCapability[] = [];
    for (const throws of [false, true]) {
      h.register(
        route({
          handler: async (_req, _res, capability) => {
            retained.push(capability);
            if (throws) {
              throw new Error("handler failed");
            }
            return true;
          },
        }),
      );
      const response = await h.request("test-positive");
      expect(response.res.statusCode).toBe(throws ? 500 : 200);
      expect(retained).toHaveLength(throws ? 2 : 1);
      await expect(retained.at(-1)!.submit({ message: "late" })).rejects.toThrow("inactive");
    }
    expect(h.effects).toEqual([]);
  });
});
