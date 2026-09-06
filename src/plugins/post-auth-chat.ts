/** Experimental bound-chat-v1. Installed plugins remain trusted in-process JavaScript. */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { types } from "node:util";
import { z } from "zod";
import { boundChatDeclarationSchema, type BoundChatStartupGrant } from "../config/bound-chat.js";
import type { GatewayRequestOptions } from "../gateway/server-methods/types.js";
import type { GatewayMethodDispatchResponse } from "../gateway/server-plugins.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";
import type { OpenClawPluginHttpRouteHandler } from "./types.js";

export { boundChatDeclarationSchema };
export type BoundChatDeclaration = z.infer<typeof boundChatDeclarationSchema>;

/** Inspect descriptors without executing getters/proxy traps at the authority boundary. */
export function boundChatData(value: unknown): unknown {
  if (typeof value !== "object" || value === null || types.isProxy(value)) {
    return undefined;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    return undefined;
  }
  const snapshot: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== "string" || !("value" in descriptor)) {
      return undefined;
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

const authenticationSchema = z
  .object({
    authenticated: z.literal(true),
    conversationKey: z.string().min(1).max(1024),
    operationKey: z.string().min(1).max(1024),
  })
  .strict();
const submitSchema = z
  .object({
    message: z.string(),
    // Preserve Gateway unknown[] and byte limits; media parsing/staging stays in chat.send.
    attachments: z.array(z.unknown()).optional(),
    timeoutMs: z.number().int().nonnegative().optional(),
  })
  .strict();
const waitSchema = z.object({ timeoutMs: z.number().int().nonnegative().optional() }).strict();
const readSchema = z
  .object({
    limit: z.number().int().min(1).max(1000).optional(),
    offset: z.number().int().nonnegative().optional(),
    maxChars: z.number().int().min(1).max(500_000).optional(),
  })
  .strict();

declare const capabilityBrand: unique symbol;
type BoundChatCapability = {
  readonly [capabilityBrand]: true;
  /** Persistable correlation data, not authority or proof that an operation executed. */
  readonly binding: Readonly<{
    version: "bound-chat-binding-v1";
    sessionKey: string;
    runId: string;
  }>;
  readonly submit: (input: z.infer<typeof submitSchema>) => Promise<GatewayMethodDispatchResponse>;
  readonly wait: (input?: z.infer<typeof waitSchema>) => Promise<GatewayMethodDispatchResponse>;
  readonly read: (input?: z.infer<typeof readSchema>) => Promise<GatewayMethodDispatchResponse>;
};
export type BoundChatRoute = BoundChatDeclaration & {
  /** Parse, authenticate, authorize these conversation/operation labels AND check replay.
   * Recovery authenticates again with the same authorized labels, never raw Gateway targets.
   */
  authenticate: (
    req: IncomingMessage,
    res: ServerResponse,
  ) =>
    | false
    | z.infer<typeof authenticationSchema>
    | Promise<false | z.infer<typeof authenticationSchema>>;
  handler: (
    req: IncomingMessage,
    res: ServerResponse,
    capability: BoundChatCapability,
  ) => ReturnType<OpenClawPluginHttpRouteHandler>;
};
export const boundChatRouteSchema = boundChatDeclarationSchema
  .extend({
    authenticate: z.custom<BoundChatRoute["authenticate"]>((value) => typeof value === "function"),
    handler: z.custom<BoundChatRoute["handler"]>((value) => typeof value === "function"),
  })
  .strict();

const invocations = new AsyncLocalStorage<object>();
const boundChatClients = new WeakMap<
  object,
  {
    scope: NonNullable<ReturnType<typeof getPluginRuntimeGatewayRequestScope>>;
    assertActive: () => void;
    grant: BoundChatStartupGrant;
  }
>();

/** Core-only authorization metadata. Never a plugin runtime ambient operator client. */
export function getBoundChatClient(client: GatewayRequestOptions["client"]) {
  return client === null ? undefined : boundChatClients.get(client);
}
export function assertBoundChatActive(client: GatewayRequestOptions["client"]): void {
  getBoundChatClient(client)?.assertActive();
}

/** Only the registry constructs wrappers, from validated frozen declaration/callback snapshots. */
export function createBoundChatHandler(params: {
  pluginId: string;
  route: Readonly<BoundChatRoute>;
  grant: BoundChatStartupGrant;
  isCurrent: () => boolean;
  getGeneration: () => object | undefined;
}): OpenClawPluginHttpRouteHandler {
  const { path, agentId, profile, authenticate, handler } = params.route;
  return async (req, res) => {
    const generation = params.getGeneration();
    const scope = getPluginRuntimeGatewayRequestScope();
    if (
      !scope?.context ||
      !scope.client ||
      scope.pluginId !== params.pluginId ||
      !params.isCurrent()
    ) {
      throw new Error("inactive bound chat route");
    }
    const lifetime = new AbortController();
    const revoke = () => lifetime.abort();
    res.once("close", revoke);
    res.once("finish", revoke);
    const responseClaimed = () =>
      lifetime.signal.aborted || res.destroyed || res.writableEnded || res.headersSent;
    try {
      // Nothing callable is minted before the plugin-owned parser/auth/replay stage succeeds.
      let authenticationResult: Awaited<ReturnType<BoundChatRoute["authenticate"]>>;
      try {
        authenticationResult = await authenticate(req, res);
      } catch (error) {
        // The outer failure response is safe only while authentication still owns an open response.
        if (responseClaimed()) {
          return true;
        }
        throw error;
      }
      // End/header flags cover synchronous completion; the event latch covers async finish/close races.
      // Claim the route before parsing or minting, even if authentication returned positive labels.
      if (responseClaimed()) {
        return true;
      }
      const authenticated = authenticationSchema.safeParse(boundChatData(authenticationResult));
      if (!authenticated.success) {
        res.statusCode = 401;
        res.end("Unauthorized");
        return true;
      }
      const invocation = {};
      const assertActive = () => {
        if (
          lifetime.signal.aborted ||
          invocations.getStore() !== invocation ||
          getPluginRuntimeGatewayRequestScope() !== scope ||
          !params.isCurrent() ||
          params.getGeneration() !== generation ||
          res.destroyed ||
          res.writableEnded
        ) {
          throw new Error("inactive bound chat capability");
        }
      };
      const namespace = [
        "openclaw.bound-chat.session.v1",
        params.grant.identity,
        profile,
        params.pluginId,
        path,
        agentId,
        authenticated.data.conversationKey,
      ];
      const digest = (parts: string[]) =>
        createHash("sha256").update(JSON.stringify(parts)).digest("hex");
      const sessionKey = `agent:${agentId}:plugin-chat:${digest(namespace)}`;
      const runId = digest([
        "openclaw.bound-chat.run.v1",
        ...namespace,
        authenticated.data.operationKey,
      ]);
      const dispatch = async (
        method: "chat.send" | "agent.wait" | "chat.history",
        input: Record<string, unknown>,
      ) => {
        assertActive();
        const { dispatchGatewayMethodInProcessRaw } = await import("../gateway/server-plugins.js");
        assertActive();
        let result: GatewayMethodDispatchResponse;
        try {
          result = await dispatchGatewayMethodInProcessRaw(method, input, {
            forceSyntheticClient: true,
            syntheticScopes: [method === "chat.history" ? "operator.read" : "operator.write"],
            // Attach lifetime to the direct authorization client. Core checks it at resolved
            // handler entry AND chat admission; lazy imports cannot outlive authority.
            beforeDispatch: (client) => {
              assertActive();
              if (client) {
                boundChatClients.set(client, { scope, assertActive, grant: params.grant });
              }
            },
          });
        } catch {
          assertActive();
          // No raw filesystem/provider exception, cause or metadata crosses the
          // capability boundary. Failure is not proof that submission had no effect.
          throw new Error("bound chat operation failed");
        }
        assertActive();
        return result.ok
          ? result
          : { ok: false, error: { code: "UNAVAILABLE", message: "bound chat operation failed" } };
      };
      return await invocations.run(invocation, async () => {
        assertActive();
        const capability = {
          binding: Object.freeze({ version: "bound-chat-binding-v1" as const, sessionKey, runId }),
          submit: async (input: z.infer<typeof submitSchema>) => {
            assertActive();
            return await dispatch("chat.send", {
              ...submitSchema.parse(input),
              agentId,
              sessionKey,
              idempotencyKey: runId,
              deliver: false,
            });
          },
          // Wait/read can recover uncertain prior submissions. A timeout is not proof of no effect.
          wait: async (input: z.infer<typeof waitSchema> = {}) => {
            assertActive();
            return await dispatch("agent.wait", { ...waitSchema.parse(input), runId });
          },
          read: async (input: z.infer<typeof readSchema> = {}) => {
            assertActive();
            return await dispatch("chat.history", {
              ...readSchema.parse(input),
              agentId,
              sessionKey,
            });
          },
        };
        Object.defineProperty(capability, "toJSON", {
          value: () => {
            throw new Error("nonserializable capability");
          },
        });
        Object.setPrototypeOf(capability, null);
        await handler(req, res, Object.freeze(capability) as BoundChatCapability);
        // Positive authentication claims this route even if plugin code returns false.
        return true;
      });
    } finally {
      // Accepted runs continue; revocation prevents new admission, not rollback/exactly-once.
      revoke();
      res.removeListener("close", revoke);
      res.removeListener("finish", revoke);
    }
  };
}
