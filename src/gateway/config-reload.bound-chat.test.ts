/** Operator authority cannot be downgraded by plugin hot/noop metadata. */
import { expect, it } from "vitest";
import { diffConfigPaths } from "./config-diff.js";
import { buildGatewayReloadPlan, resolveConfigReloadMetadata } from "./config-reload-plan.js";

it.each([
  {},
  { plugins: {} },
  { plugins: { entries: {} } },
  { plugins: { entries: { example: {} } } },
])("ancestor removal of grants still requires restart: %j", (next) => {
  const previous = {
    plugins: { entries: { example: { grants: { boundChat: [{ allow: true }] } } } },
  };
  for (const [a, b] of [
    [previous, next],
    [next, previous],
  ]) {
    const paths = diffConfigPaths(a, b);
    const plan = buildGatewayReloadPlan(paths);
    expect(plan.restartGateway).toBe(true);
    expect(plan.reloadPlugins).toBe(false);
  }
});

it.each([
  "plugins.entries.example.grants.boundChat",
  "plugins.entries.example.grants.boundChat.0.allow",
  "plugins.entries.example.grants.boundChat.0.path",
  "plugins.entries.example.grants.boundChat.0.agentId",
  "plugins.entries.example.grants.boundChat.0.profile",
  "plugins.entries.example.grants",
])("requires restart for %s", (changed) => {
  expect(resolveConfigReloadMetadata(changed)).toEqual({ kind: "restart" });
  const plan = buildGatewayReloadPlan([changed], { noopPaths: [changed] });
  expect(plan.restartGateway).toBe(true);
  expect(plan.reloadPlugins).toBe(false);
  expect(plan.hotReasons).toEqual([]);
  expect(plan.noopPaths).toEqual([]);
});
