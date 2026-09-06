// Runtime config helpers expose scoped OpenClaw config reads to plugin runtimes.
import { hasOperatorGrants, withoutOperatorGrants } from "../../config/bound-chat.js";
import { getRuntimeConfig } from "../../config/config.js";
import type { ConfigReplaceResult } from "../../config/mutate.js";
import { mutateConfigFile as mutateConfigFileInternal } from "../../config/mutate.js";
import type { OpenClawConfig, ConfigFileSnapshot } from "../../config/types.openclaw.js";
import { logWarn } from "../../logger.js";
import { getPluginRuntimeGatewayRequestScope } from "./gateway-request-scope.js";
import type { PluginRuntime } from "./types.js";

const RUNTIME_CONFIG_LOAD_WRITE_COMPAT_CODE = "runtime-config-load-write";

const warnedDeprecatedConfigApis = new Set<string>();

function formatDeprecatedConfigApiSubject(name: "loadConfig" | "writeConfigFile"): string {
  const scope = getPluginRuntimeGatewayRequestScope();
  if (!scope?.pluginId) {
    return `plugin runtime config.${name}()`;
  }
  return `plugin "${scope.pluginId}" runtime config.${name}()`;
}

function formatDeprecatedConfigApiSource(): string {
  const scope = getPluginRuntimeGatewayRequestScope();
  return scope?.pluginSource ? ` Source: ${scope.pluginSource}` : "";
}

function formatDeprecatedConfigApiWarningKey(name: "loadConfig" | "writeConfigFile"): string {
  const scope = getPluginRuntimeGatewayRequestScope();
  return `${name}:${scope?.pluginId ?? "anonymous"}`;
}

function warnDeprecatedConfigApiOnce(
  name: "loadConfig" | "writeConfigFile",
  replacement: string,
): void {
  const warningKey = formatDeprecatedConfigApiWarningKey(name);
  if (warnedDeprecatedConfigApis.has(warningKey)) {
    return;
  }
  warnedDeprecatedConfigApis.add(warningKey);
  logWarn(
    `${formatDeprecatedConfigApiSubject(name)} is deprecated (${RUNTIME_CONFIG_LOAD_WRITE_COMPAT_CODE}); use ${replacement}.${formatDeprecatedConfigApiSource()}`,
  );
}

/** @internal Test-only reset for the runtime config compatibility warning cache. */
export function resetRuntimeConfigDeprecationWarningStateForTest(): void {
  warnedDeprecatedConfigApis.clear();
}

function assertNoOperatorGrants(config: OpenClawConfig): void {
  if (hasOperatorGrants(config)) {
    throw new Error("bound chat grants are operator-owned; edit operator config and restart");
  }
}
function visibleSnapshot(snapshot: ConfigFileSnapshot): ConfigFileSnapshot {
  return {
    ...snapshot,
    raw: null,
    parsed: withoutOperatorGrants(snapshot.config),
    sourceConfig: withoutOperatorGrants(snapshot.sourceConfig),
    resolved: withoutOperatorGrants(snapshot.resolved),
    runtimeConfig: withoutOperatorGrants(snapshot.runtimeConfig),
    config: withoutOperatorGrants(snapshot.config),
  };
}
function visibleResult<T extends ConfigReplaceResult>(result: T): T {
  return {
    ...result,
    snapshot: visibleSnapshot(result.snapshot),
    nextConfig: withoutOperatorGrants(result.nextConfig),
  };
}

const mutatePluginConfig: PluginRuntime["config"]["mutateConfigFile"] = async (params) => {
  // Only the public runtime options cross this boundary. Internal explicit-set,
  // snapshot and precommit hooks would provide a second, unredacted write path.
  const writeOptions = params.writeOptions && structuredClone(params.writeOptions);
  for (const key of Object.keys(params.writeOptions ?? {})) {
    if (!["envSnapshotForRestore", "expectedConfigPath", "unsetPaths"].includes(key)) {
      throw new Error("unsupported plugin config write option; grants are operator-owned");
    }
  }
  for (const segments of writeOptions?.unsetPaths ?? []) {
    const grantPath = ["plugins", "entries", segments[2], "grants"];
    if (segments.slice(0, 4).every((part, index) => part === grantPath[index])) {
      throw new Error("bound chat grants are operator-owned; cannot unset this path");
    }
  }
  const result = await mutateConfigFileInternal({
    base: params.base,
    baseHash: params.baseHash,
    afterWrite: params.afterWrite,
    writeOptions,
    mutate: async (draft, context) => {
      const visible = structuredClone(withoutOperatorGrants(draft));
      const value = await params.mutate(visible, {
        ...context,
        snapshot: visibleSnapshot(context.snapshot),
      });
      assertNoOperatorGrants(visible);
      // Never reinsert grants into a callback-retained or returned object.
      const next = structuredClone(visible);
      // The callback cannot see or author grants. Preserve them even when it removes an entry.
      for (const [id, entry] of Object.entries(draft.plugins?.entries ?? {})) {
        if (entry.grants !== undefined) {
          next.plugins ??= {};
          next.plugins.entries ??= {};
          next.plugins.entries[id] = { ...next.plugins.entries[id], grants: entry.grants };
        }
      }
      for (const key of Object.keys(draft)) {
        delete draft[key as keyof OpenClawConfig];
      }
      Object.assign(draft, next);
      return value;
    },
  });
  return visibleResult(result);
};
const replacePluginConfig: PluginRuntime["config"]["replaceConfigFile"] = async (params) => {
  assertNoOperatorGrants(params.nextConfig);
  const nextConfig = structuredClone(params.nextConfig);
  // Always acquire the mutation owner's lock and preserve its fresh disk draft;
  // a runtime snapshot cannot tell us whether an operator just added a grant.
  return await mutatePluginConfig({
    baseHash: params.baseHash,
    afterWrite: params.afterWrite,
    writeOptions: params.writeOptions,
    mutate: (draft) => {
      for (const key of Object.keys(draft)) {
        delete draft[key as keyof OpenClawConfig];
      }
      Object.assign(draft, nextConfig);
    },
  });
};

export function createRuntimeConfig(): PluginRuntime["config"] {
  return {
    current: () => withoutOperatorGrants(getRuntimeConfig()),
    mutateConfigFile: mutatePluginConfig,
    replaceConfigFile: replacePluginConfig,
    loadConfig: () => {
      warnDeprecatedConfigApiOnce("loadConfig", "config.current()");
      return withoutOperatorGrants(getRuntimeConfig());
    },
    writeConfigFile: async (cfg, options) => {
      warnDeprecatedConfigApiOnce(
        "writeConfigFile",
        "config.mutateConfigFile(...) or config.replaceConfigFile(...)",
      );
      const { afterWrite, ...writeOptions } = options ?? {};
      await replacePluginConfig({
        nextConfig: cfg,
        afterWrite: afterWrite ?? { mode: "auto" },
        writeOptions,
      });
    },
  };
}
