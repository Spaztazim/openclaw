/** Operator-only cold-start bound-chat authority. Never inferred from plugin enablement. */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { canonicalizePathVariant } from "../gateway/security-path.js";
import { resolveSessionRoutingContract } from "./sessions/main-session.js";
import { resolveStorePath } from "./sessions/paths.js";
import type { OpenClawConfig } from "./types.openclaw.js";

export const boundChatDeclarationSchema = z
  .object({
    path: z
      .string()
      .regex(/^\/[a-z0-9/_-]+$/)
      .refine((value) => value === canonicalizePathVariant(value)),
    agentId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
    profile: z.literal("bound-chat-v1"),
  })
  .strict();
export const boundChatGrantsSchema = z
  .object({
    boundChat: z
      .array(boundChatDeclarationSchema.extend({ allow: z.literal(true) }).strict())
      .refine(
        (grants) =>
          new Set(grants.map((grant) => JSON.stringify([grant.profile, grant.path]))).size ===
          grants.length,
        "duplicate bound chat grant slot",
      )
      .optional(),
  })
  .strict();

/** Detached view: plugins neither receive grants nor a mutable reference to their owner. */
export function hasOperatorGrants(config: OpenClawConfig): boolean {
  return Object.values(config.plugins?.entries ?? {}).some((entry) =>
    Object.hasOwn(entry, "grants"),
  );
}
export function withoutOperatorGrants<T extends OpenClawConfig>(config: T): T {
  const visible = structuredClone(config);
  for (const entry of Object.values(visible.plugins?.entries ?? {})) {
    delete entry.grants;
  }
  return visible;
}
function freezeTree<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      freezeTree(child);
    }
    Object.freeze(value);
  }
  return value;
}
export type BoundChatStartupGrant = Readonly<
  z.infer<typeof boundChatDeclarationSchema> & {
    pluginId: string;
    identity: string;
    config: OpenClawConfig;
  }
>;
export type BoundChatStartup = Readonly<{
  grants: readonly BoundChatStartupGrant[];
  invalid: boolean;
}>;

function pinPhysicalStorePath(storePath: string): string {
  // Node's native-platform realpath handles junctions/drive/UNC paths on Windows;
  // never lowercase paths or emulate Windows filesystem identity on POSIX.
  try {
    const physical = fs.realpathSync(storePath);
    if (!fs.statSync(physical).isFile()) {
      throw new Error("invalid store target");
    }
    return physical;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    // A dangling symlink is not an absent file. Require the immediate parent;
    // creating speculative ancestors could follow a later symlink at first use.
    if (fs.lstatSync(storePath, { throwIfNoEntry: false })) {
      throw new Error("invalid store target", { cause: error });
    }
    const parent = fs.realpathSync(path.dirname(storePath));
    if (!fs.statSync(parent).isDirectory()) {
      throw new Error("invalid store parent", { cause: error });
    }
    return path.join(parent, path.basename(storePath));
  }
}

/** Validate the whole set before minting any grant. Diagnostics never serialize rejected values. */
export function prepareBoundChatStartup(config: OpenClawConfig): BoundChatStartup {
  const grants: BoundChatStartupGrant[] = [];
  try {
    for (const [pluginId, entry] of Object.entries(config.plugins?.entries ?? {})) {
      if (entry.grants === undefined) {
        continue;
      }
      const parsed = boundChatGrantsSchema.safeParse(entry.grants);
      if (!parsed.success) {
        return Object.freeze({ grants: Object.freeze([]), invalid: true });
      }
      for (const { allow: _allow, ...grant } of parsed.data.boundChat ?? []) {
        if (!config.agents?.list?.some((agent) => agent.id === grant.agentId)) {
          return Object.freeze({ grants: Object.freeze([]), invalid: true });
        }
        const storePath = pinPhysicalStorePath(
          resolveStorePath(config.session?.store, { agentId: grant.agentId }),
        );
        // Ordered JSON tuple + domain separation. No raw config/path enters public receipts.
        const identity = createHash("sha256")
          .update(
            JSON.stringify([
              "openclaw.bound-chat.startup-binding.v1",
              grant.agentId,
              storePath,
              resolveSessionRoutingContract(config),
            ]),
          )
          .digest("hex");
        const snapshot = structuredClone(withoutOperatorGrants(config));
        snapshot.session = { ...snapshot.session, store: storePath };
        grants.push(Object.freeze({ pluginId, ...grant, identity, config: freezeTree(snapshot) }));
      }
    }
  } catch {
    return Object.freeze({ grants: Object.freeze([]), invalid: true });
  }
  return Object.freeze({ grants: Object.freeze(grants), invalid: false });
}
