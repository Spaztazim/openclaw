import { expect, it } from "vitest";
import { redactConfigSnapshot, REDACTED_SENTINEL } from "./redact-snapshot.js";
import { makeSnapshot } from "./redact-snapshot.test-helpers.js";
import { buildConfigSchema } from "./schema.js";
import { isSensitiveConfigPath } from "./sensitive-paths.js";
import { OpenClawSchema } from "./zod-schema.js";

const grant = { allow: true, profile: "bound-chat-v1", path: "/bound", agentId: "fixed" };
it("publishes operator help/labels and redacts grant values in normal config snapshots", () => {
  const { uiHints } = buildConfigSchema();
  expect(uiHints["plugins.entries.*.grants"].sensitive).toBe(true);
  expect(uiHints["plugins.entries.*.grants.boundChat"].help).toContain("restart");
  expect(isSensitiveConfigPath("plugins.entries.example.grants.boundChat.0.path")).toBe(true);
  const result = redactConfigSnapshot(
    makeSnapshot({ plugins: { entries: { example: { grants: { boundChat: [grant] } } } } }),
    uiHints,
  );
  expect(result.config.plugins?.entries?.example.grants).toBe(REDACTED_SENTINEL);
  expect(JSON.stringify(result)).not.toContain('"/bound"');
});
it("rejects duplicate slots at schema validation without enabling absent grants", () => {
  expect(
    OpenClawSchema.safeParse({
      plugins: { entries: { example: { grants: { boundChat: [grant, grant] } } } },
    }).success,
  ).toBe(false);
  expect(
    OpenClawSchema.parse({ plugins: { entries: { example: {} } } }).plugins?.entries?.example
      .grants,
  ).toBeUndefined();
});
