# Bound chat local spike

## Corrective continuation after KEEP_AND_HARDEN: acceptance INCOMPLETE

Review reference supplied by parent: `d1a79591c456cecf69192d6b79677d511bb63ccd8274a9cd72872c01ce973181`. This continuation did not independently recompute that digest. Same local branch and accumulated uncommitted worktree; no staging/commit/push, remote/host/service actions, live install, or Colony integration. Cached Node v22.22.3 was confirmed at entry. Parent build/gate results are prior evidence, not acceptance of the new diff.

Implemented corrective changes:

- B1: all plugin replacements and deprecated writes now go through the locked mutation owner. No stale runtime-config branch. Protected unset paths (root, plugins, entries, enclosing entry, grants, and descendants) reject before the mutation callback/write. Public runtime write options are explicitly limited to envSnapshotForRestore, expectedConfigPath and unrelated unsetPaths; internal explicitSetPaths/value source, snapshot, precommit and destination overrides reject rather than providing another write path. Options are detached. Fresh locked draft grants are preserved. Reinsertion uses a new clone, never a callback-retained/returned visible draft. Runtime current/deprecated reads and snapshot config fields are detached and grant-free.
- B2: CLI-metadata buildPluginApi receives a detached grant-free config. The common buildPluginApi boundary also strips grants, covering registry, captured-registration and setup-registry callers rather than relying only on the normal registry path. Real CLI-metadata fixture throws if any entry exposes grants.
- B3: removed module-global boundChatStartup from generic loader. startGatewayServer creates the snapshot after authBootstrap supplies validated startup config. Explicit threading through prepareGatewayPluginBootstrap, loadGatewayStartupPluginRuntime, loadGatewayStartupPlugins/prepareGatewayPluginLoad, loadGatewayPlugins, deferred loading and attached plugin reload closures. Authority-bearing registry loads bypass shared generic loader caches so one instance cannot cache authority for another/generic caller. Generic loader calls without a supplied owner have zero grants. No shared transactional loader redesign or global reset to refresh the owner.
- B4: cold preparer realpaths an existing regular file; if genuinely absent, requires and realpaths the immediate existing directory. Dangling file symlinks, directory-as-file, missing parents and resolution errors fail closed. Snapshot config and domain-separated identity use the physical target. Node native-platform filesystem/path semantics are used; no manual Windows case folding or POSIX emulation of NTFS.
- Hardening: schema rejects duplicate/conflicting plugin/profile/path slots. Bound history does not schedule global managed-image cleanup; ordinary history still does. Thrown/returned operation failures are sanitized without raw payload/error details/meta; revoked capability errors retain their lifetime checks.
- Added operator documentation in docs/gateway/configuration-reference.md and manifest/API guidance in docs/plugins/manifest.md. Added schema labels/help and grant redaction classification/metadata. No defaults, auto-grants, enabling migration or changelog/release claim. Root policy makes CHANGELOG.md release-only.

Real RED evidence:

- `.artifacts/b1-red.log`: real config I/O, 20 tests / 14 failed. Includes missing protected-unset rejection, stale replacement path, callback-retained grant leakage, internal option forwarding and queued operator/plugin writes. Some destructive RED payloads were independently blocked by the existing config size-drop guard; those failures prove the missing plugin-boundary behavior, not successful deletion in every case.
- `.artifacts/b2-b3-red.log`: 20 tests / 2 failed. CLI metadata registration returned error after fixture detected grants; generic scoped load minted one bound route instead of zero.
- `.artifacts/b4-red.log`: 9 tests / 9 failed: parent/file physical identity, absent-file parent pinning, missing/dangling/directory/I/O failures, duplicates and conflicts.
- `.artifacts/h-cleanup-red.log`: 3 tests / 3 failed. Real bound history/store reads invoked global managed-image cleanup (runtime, parent-symlink and file-symlink cases).
- `.artifacts/h-errors-red.log`: 2 failed / 51 filtered out. Both thrown EACCES and returned EIO-shaped method failures exposed the raw test path.
- `.artifacts/h-metadata-red.log`: metadata/redaction RED command exited 1; count not extracted.

GREEN commands completed for this continuation (all via scripts/run-vitest.mjs):

- `.artifacts/b1-green.log`: real config-I/O suite command exited 0. Exercises protected unsets, unrelated unset, stale/newer disk grant preservation, in-flight locked operator mutation followed by plugin replacement, grant injection rejection and retained callback/context/result non-disclosure.
- `.artifacts/b2-b3-b4-green.log`: real loader owner/CLI metadata and physical pinning suites command exited 0.
- `.artifacts/corrective-plugins.log`: exit 0 across loader.bound-chat-owner, bound-chat-store-pinning, runtime/runtime-config.bound-chat, runtime/runtime-config, loader.runtime-registry, manifest.json5-tolerance, installed-plugin-index, http-registry and registry test files. Count not extracted; do not infer a total.
- `.artifacts/corrective-gateway.log`: exit 0 across config-reload.bound-chat, config-reload, server/plugins-http.post-auth-chat, server/plugins-http.bound-chat-lazy, server/plugins-http.runtime-scopes, server-startup-plugins and server-plugins test files. Count not extracted.
- `.artifacts/corrective-chat.log`: 2 files / 8 passed / 134 filtered out with `-t 'post-auth|bound-chat'`. Includes three real history/store cases that continue reading A after runtime/parent-symlink/file-symlink drift, unchanged physical target recovery, changed-target namespace isolation, zero bound global cleanup, and preserved ordinary cleanup. Submit's terminal effect is stubbed in the new store tests; existing directive tests exercise real send handling.
- `.artifacts/corrective-config.log`: exit 0 across bound-chat, redact-snapshot, config-misc and schema.help.quality tests after metadata changes. Count not extracted.
- `.artifacts/corrective-types.log`: empty core-test diagnostics log from the typecheck invocation before final schema/help/docs edits. The shell subsequently ran docs:list, so its overall exit code is not an independently captured typecheck status; rerun both type gates before acceptance.
- `.artifacts/corrective-docs-list.log`: docs listing completed. This is discovery, not docs validation.

Proof boundaries and unfinished acceptance:

- Run-time budget warning ended this continuation before lint/format, SDK export/surface/API, config-doc baseline/schema generator checks, docs validation, full build, final typechecks and final diff-check/status. No complete acceptance claim. No generated hashes were hand-edited or regenerated in this slice.
- The real owner test exercises actual Gateway runtime bootstrap and hot-reload wiring helpers with interleaved owner snapshots and generic scoped-before/full/after loads, then creates a fresh owner without resetting globals. It is not a full socket-bearing Gateway/no-respawn run-loop lifecycle test. Exact run-loop call-site review was started but not completed; do not claim end-to-end in-process restart proof. Existing Gateway globals remain compatibility scaffolding, not general multi-Gateway isolation.
- Native Windows/NTFS filesystem execution was not run. Tests use Node symlink file/junction APIs and physical temp roots on Linux. This proves Linux behavior only.
- Startup pinning is not a sandbox against privileged replacement of the pinned physical target. Trusted same-context JavaScript can still use filesystem APIs.
- Expanded all-surface B1 adversarial coverage, including environment-reference restoration and include-file interactions, should be reviewed before calling the whole write boundary complete. Internal explicit-set options are deliberately rejected because they are not in the supported plugin runtime write-options type; unrelated supported unset semantics pass.
- The store tests use the actual current session-accessor/store implementation. Earlier report wording calling them SQLite-specific was not justified: current store facade imports store-load/store-writer and still has file-backed session persistence. No storage redesign was attempted.
- Bound-session transcript read code remains intact; the new symlink tests seed real session entries, not nonempty transcript messages. Existing real chat/history tests provide broader transcript coverage, but a dedicated nonempty-transcript symlink fixture was not added.

Everything below is historical evidence/status from earlier slices, superseded where the corrective section above describes a changed owner or fixed gap.

## Latest continuation: restart-only implementation INCOMPLETE

Status: UNCOMMITTED WORK IN PROGRESS; NOT deployable. The parent corrected the previous atomic-hot-replacement requirement to cold-start grants plus restart-only grant changes. The shared transactional loader findings below are historical findings, not requirements or blockers for the corrected contract. Their two ordinary failing exploratory tests were replaced with cold-start contract tests; no skip/expected-failure workaround was added.

Implemented so far in this continuation:

- Added the operator config type/schema `plugins.entries.<id>.grants.boundChat`, exact `allow:true`, supported profile, canonical path, explicit `agents.list` membership, whole-set rejection and sanitized registry diagnostic. No defaults or enabling migration.
- Added `src/config/bound-chat.ts`: validated/frozen startup grant snapshots; domain-separated ordered-JSON hash of explicit agent, resolved effective store path and existing session-routing contract. Snapshots retain detached frozen startup config with the expanded store path.
- Production loader latches the snapshot on its first activating non-validation load; subsequent ordinary loader calls reuse that startup authority. The whole-loader test reset clears the latch. The old `boundChatGrantsForTest` seam was replaced with internal `boundChatStartup` snapshots produced by the shared preparer.
- Registry registration intersects manifest profile, exact startup grant and runtime declaration. Plugin API config views omit grants. Runtime config read/write wrappers were modified to omit grants and preserve operator fields across plugin mutation; this write-boundary work is NOT fully verified (see gaps below).
- Grant paths take precedence over hot/noop metadata and require restart. Added config-diff detection for whole ancestor addition/removal, so removing an entry or plugins object cannot hide the authority delta. Grant-change plans suppress plugin reload.
- Startup identity is included in session/run namespaces. Fixed dispatch context and send/history session loading use the startup config, including queued send admission. Ordinary requests retain current-config loading. Existing capability generation/lifetime checks remain.

New RED evidence on cached Node v22.22.3:

- `.artifacts/cold-red-loader.log`: 18 tests, 15 failed / 3 passed. Initial loader/schema/visibility failures. A subsequent table-fixture correction wrapped array-valued cases so Vitest does not spread them into arguments; final loader run below uses corrected cases.
- `.artifacts/cold-red-planner.log`: 6 failed restart-policy tests.
- `.artifacts/cold-red-namespace.log`: 4 failed / 47 skipped; different store/scope/main alias/default agent produced the same namespace before binding was added.
- `.artifacts/cold-red-runtime-config.log`: runtime grant visibility/replacement RED command exited 1; exact count not extracted.
- `.artifacts/cold-red-parent-removal.log`: ancestor-removal RED command exited 1; exact count not extracted.
- `.artifacts/cold-red-store.log`: 1 failed real history/store test. With the startup-config selection temporarily omitted from `loadSessionEntry`, an old A binding actually read `sessionId: store-b-unrelated`. Startup-config selection was restored for GREEN.

Latest execution evidence:

- `.artifacts/cold-green-store.log`: 1 file / 1 passed. Real `chat.history` and SQLite session-accessor reads; only submit terminal effect is stubbed. Old A binding reads A after live config changes to B; mutating original startup config cannot retarget it; unchanged startup has same key and reads A; B startup has distinct key and cannot read the unrelated B row under the old key. Returned receipts did not contain the temporary store root.
- `.artifacts/cold-green-loader2.log`: 3 files / 53 passed (`loader.bound-chat-owner`, `runtime/runtime-config`, `loader.runtime-registry`). Includes corrected array-valued invalid grant cases and process-reset/restart behavior.
- `.artifacts/cold-green-gateway.log`: 4 files / 69 passed (initial restart planner plus bound-chat Gateway/lazy/GHSA). This preceded the ancestor-removal additions.
- `.artifacts/cold-green-real.log`: 1 file / 5 passed / 134 skipped, filter `post-auth|bound-chat`. Existing real-chat handler tests retain their session-utils wrapper mocks; do not confuse those with the new real-store test above.
- `.artifacts/cold-types2.log`: core-test typecheck command exited 0 after current type fixes. Later config-diff correction was not re-typechecked.
- `.artifacts/cold-green-reload.log`: 2 files / 95 passed / 2 failed. The failures were existing duplicate install-path expectations accidentally changed by whole-output deduplication in the new diff wrapper. Corrected to preserve existing duplicates and append only a missing authority-specific path. NOT rerun after that correction.
- `.artifacts/cold-lint.log`: scoped lint exited 1. Diagnostics not inspected before execution limit. No passing lint claim.

Remaining gaps / do not claim acceptance:

- Runtime config mutation ownership needs adversarial proof and correction: all mutation context/result paths, replacement against freshly changed on-disk grants, `writeOptions.unsetPaths`/explicit-set values, legacy APIs, and other plugin config exposure paths. Current wrapper coverage is insufficient to claim that plugins cannot read/mutate grants through every supported config API. In-process plugins are still trusted JavaScript, not sandboxed.
- Complete sanitized operation-error/diagnostic tests; current real-store success receipts prove only the tested no-path-leakage case, not all error paths.
- Add/prove actual chat admission with startup store drift, not just real history and existing revocation tests. Confirm every downstream store/routing consumer keeps the startup binding.
- Review cold-start latch initialization across empty/scoped/setup loader paths and actual Gateway startup; current proof exercises the real loader, not a full Gateway cold-start process.
- Config schema/help/labels/redaction metadata and operator docs are not yet aligned. No release/changelog claims were written. Agent-membership validation currently occurs in the startup preparer; schema-level membership diagnostics need completion.
- Review canonical effective storage identity, including filesystem aliases and the underlying SQLite routing owner. Current identity uses the established `resolveStorePath` result and `resolveSessionRoutingContract`.
- Rerun corrected reload tests, broader config/schema/loader suites, all focused Gateway/store/chat tests, core and core-test types, scoped lint and final formatting.
- SDK export/surface/API checks, full build, final diff-check/status have NOT run for this continuation. Earlier parent GREEN is not evidence for these new changes.

The execution limit ended this continuation while these changes were still in progress. No completed production-authority or acceptance claim. No shared transactional loader redesign, Colony integration, commit/staging/push, remote/host/service actions, credentials, or live installation.

## Historical metadata/API verification and superseded atomic-owner investigation

Historical status: local, uncommitted spike; NOT deployable. The parent subsequently verified the metadata/API slice after formatting: manifest/index 57 passed, Gateway/lazy/GHSA 59 passed, real chat 5 passed on Node 22.22.3, core/core-test types, format, SDK export/surface/API at the unchanged 10466 budget, full build, and diff-check. Those are parent-provided results, not new runs below.

## Production owner slice stopped at prerequisite boundary

The latest request authorized production operator grants and session-store binding, but explicitly required stopping rather than introducing a backdoor if ownership needed broad unrelated redesign. This continuation stopped at that boundary. No production config/grant/store code was changed. The existing test-only grant seam remains; Mission 1 and Mission 2 are NOT implemented.

The blocker is the shared production loader/reload transaction, not the feasibility of expressing a strict grant in the config schema:

- `src/plugins/loader.ts:1902` clears active plugin-global state before replacement registration and before `maybeThrowOnPluginLoadError` at line 2944. The cleared owners at lines 431–440 include commands, agent harnesses, compaction, detached-task lifecycle, interactive handlers, embeddings, and memory. Retaining the old registry pointer does not restore these owners on a rejected strict load.
- `src/plugins/loader.ts:1331` maps `activate:false` to discovery mode. That is not a staged full runtime registry: a valid plugin registering its routes only in full mode has no routes in the snapshot. A discovery preflight followed by an active second load cannot establish the requested complete-new-registry-before-replacement guarantee.
- `src/gateway/server-plugin-bootstrap.ts:111` installs runtime bindings before loading plugins. `loadGatewayPlugins` invokes the activating loader without strict throw-on-load-error configuration (`src/gateway/server-plugins.ts:882`).
- `src/gateway/server.impl.ts:1374` invokes channel pre-stop, then publishes metadata and prepares the new registry at lines 1384–1397, then awaits stopping old services before replacing attached handlers and pinned surfaces at line 1405. This is not one atomic commit of the complete config/registry owner set.
- Registry retirement is conditional on all live/pinned surfaces releasing the old registry (`src/plugins/runtime.ts:118`). Switching only the active pointer would not meet Gateway route revocation requirements.

Two real-loader prerequisite regressions are retained in `src/plugins/loader.bound-chat-owner.test.ts`, without mocks of the loader or expected-failure/skip annotations:

1. Load a working plugin command; attempt strict replacement with invalid plugin config. The replacement throws and the active registry pointer remains the previous registry, but its command list is now empty. Assertion preserving the old command fails.
2. Load a plugin whose HTTP route is legitimately registered only in full mode using `activate:false`. The active registry remains unchanged, but the proposed staged registry has zero routes. Assertion requiring a complete staged route list fails.

RED execution on cached Node v22.22.3:

`node scripts/run-vitest.mjs run --config test/vitest/vitest.plugins.config.ts src/plugins/loader.bound-chat-owner.test.ts`

Result: 1 file failed, 2 failed tests. Log: `.artifacts/production-owner-red.log`. This is a prerequisite RED, not successful implementation proof; the new test file intentionally remains failing. There is no GREEN claim for production grant or store binding.

Other checks in this continuation:

- `node scripts/run-vitest.mjs run --config test/vitest/vitest.plugins.config.ts src/plugins/loader.runtime-registry.test.ts`: 1 file, 27 passed. Log: `.artifacts/production-owner-existing-loader.log`.
- `node scripts/run-tsgo.mjs -p test/tsconfig/tsconfig.core.test.json --incremental --tsBuildInfoFile .artifacts/tsgo-cache/core-test.tsbuildinfo`: exit 0 after formatting the new test.
- `node scripts/run-oxlint.mjs --tsconfig tsconfig.core.json src/plugins/loader.bound-chat-owner.test.ts`: exit 0, no preparation/lock bypass.

No fresh full build, SDK gates, core-only typecheck, or bound-chat/config/reload acceptance matrix was run after stopping; no production files changed this continuation. The historical sections below retain earlier evidence and must not be read as proof of these unimplemented missions.

Additional contract decision: `AgentConfig` (`src/config/types.agents.ts`) has no enabled/disabled field. `listAgentIds` (`src/agents/agent-scope-config.ts:75`) uses configured membership, with an implicit main-agent fallback. No new disable setting or silent interpretation of plugin enablement as agent/grant approval was introduced.

Session binding would also need to account for the effective runtime config used by `loadSessionEntry` (`src/gateway/session-utils.ts:1047`), rather than just the config used during registration. The existing `resolveSessionRoutingContract` (`src/config/sessions/main-session.ts:32`) fingerprints scope/main alias/default agent, but not backing store configuration. Session changes currently do not reload plugins, and agents.list only restarts heartbeat (`src/gateway/config-reload-plan.ts:114,137`). These facts were inspected; no namespace/store fix or cross-store recovery promise was made.

Required next owner decision: authorize a separate shared prepare/validate/commit loader-and-Gateway reload slice covering all existing registration side effects and pinned surfaces, and settle what “disabled agent” means under the existing config contract. Only then wire default-deny grants and the effective store/routing identity into that owner. Do not solve the transaction by granting from plugin-owned config, reusing incomplete discovery registries, or publishing a bound-chat-only shadow authority state.

Files changed by this continuation only: this report and the new `src/plugins/loader.bound-chat-owner.test.ts`. All previous source modifications remain uncommitted and untouched. No release/changelog claims, production grants, Colony integration, commits, staging, external systems, credentials, or live installs.

Branch: `spike/spaz-172-post-auth-capability`.
Base/HEAD: `0790d9f593ad30c940ed93b5872a8cf6d6f3cf8c`.

## Corrected metadata and authority contract

Manifest capability declaration is `contracts.boundChat: ["bound-chat-v1"]`, not structured path/agent objects. It uses the existing `normalizeTrimmedStringList` helper alongside sibling contract fields. Following existing metadata compatibility conventions, unknown strings are retained as inert metadata; empty/non-string entries are dropped. Runtime registration rejects unsupported profiles even if metadata and a grant both name them.

`InstalledPluginContributionInfo.contracts: Readonly<Record<string, readonly string[]>>` is unchanged. No installed-index production types, builder, persistence schema, or the existing channel-plugin-ids fixture were widened or suppressed. A real installed-index test verifies that profile strings survive manifest-first indexing without loading plugin runtime.

Public API remains `api.registerBoundChatRoute({path, agentId, profile: "bound-chat-v1", authenticate, handler})`. Registration requires BOTH a manifest declaration of the supported profile AND an exact core/operator grant `{pluginId,path,agentId,profile}`. The grant alone owns path/agent authorization. Manifest self-declaration alone grants nothing. Missing declarations, missing grants, mismatched plugin/path/agent/profile, and unsupported runtime profiles fail closed.

The grant fixture remains `PluginRegistryParams.boundChatGrantsForTest`; there is no production loader/config grant source. Route/grant primitive snapshots remain strict, frozen, and security-canonical; no normalization of noncanonical authority targets was added. Manifest parsing no longer imports the runtime bound-chat schema.

## Preserved hardening and trust limits

- Plugin-auth HTTP ambient scopes remain empty before and after authentication. No operator.admin.
- Direct fixed send/wait/history operations receive exact write/write/read authorization without leaking the synthetic client into unrelated plugin hooks.
- Lifecycle checks cover resolved lazy-handler entry, chat.send run reservation, queued admission, response completion/disconnect, handler exit, and registry generations.
- Canonical route overlaps are rejected; same-owner slot replacement revokes old wrappers. Positive authentication claims the request even when its handler returns false.
- Capability operations are only submit/wait/read, with fixed derived session/run binding and in-process deliver:false. Existing attachment payloads and limits remain intact.
- Installed plugins are trusted in-process JavaScript. This is not a sandbox against deliberate same-context delegation, a durable exactly-once mechanism, or a production session-store binding solution.

## Metadata slice RED evidence

All commands ran locally, as explicitly requested. Cached supported runtime: `/root/.npm/_npx/ca3942424f2c6fc5/node_modules/node/bin/node`, verified v22.22.3 and prepended to PATH. No runtime/dependency installation or download.

1. Original test-type failure independently reproduced before source edits:
   `node scripts/run-tsgo.mjs -p test/tsconfig/tsconfig.core.test.json --incremental --tsBuildInfoFile .artifacts/tsgo-cache/core-test.tsbuildinfo`
   Exit 1: `src/plugins/channel-plugin-ids.test.ts:508` TS2322, structured boundChat incompatible with string-array installed-index metadata.
   Log: `.artifacts/metadata-red-test-types.log`.
2. Updated manifest/index tests, before production correction:
   `node scripts/run-vitest.mjs run --config test/vitest/vitest.plugins.config.ts src/plugins/manifest.json5-tolerance.test.ts src/plugins/installed-plugin-index.test.ts`
   2 files failed; 4 failed / 42 passed. String declarations were lost, structured declarations incorrectly survived, installed-index profile metadata was missing.
   Log: `.artifacts/metadata-red-manifest-index.log`.
3. Updated declaration/grant intersection tests, before production correction:
   `node scripts/run-vitest.mjs run --config test/vitest/vitest.gateway-core.config.ts src/gateway/server/plugins-http.post-auth-chat.test.ts -t 'submits, waits|declaration AND|profile metadata|declared supported|unsupported runtime'`
   2 failed / 9 passed / 36 skipped. Supported string-profile declarations plus exact grants failed to produce effects. Denial cases already passed; they are not claimed as newly reproduced failures.
   Log: `.artifacts/metadata-red-intersection.log`.
4. Initial API baseline check unexpectedly PASSED against the untouched tracked hash, unlike the previous report. No API RED is claimed for this continuation. Log: `.artifacts/metadata-red-api.log`.
5. Scoped oxfmt check reported formatting issues in 12 of 16 selected files before formatting. The repo formatter was then applied to all selected spike files.

Earlier authority-boundary RED logs remain under `.artifacts/bound-chat-red-*`; they are historical proof, not new metadata-slice results.

## GREEN evidence

Focused tests after metadata correction:

- `node scripts/run-vitest.mjs run --config test/vitest/vitest.plugins.config.ts src/plugins/manifest.json5-tolerance.test.ts src/plugins/installed-plugin-index.test.ts src/plugins/http-registry.test.ts src/plugins/registry.test.ts src/plugins/runtime/gateway-request-scope.test.ts`
  4 selected files, 57 passed. Five paths supplied; project selects four. Log: `.artifacts/metadata-green-plugins.log`.
- `node scripts/run-vitest.mjs run --config test/vitest/vitest.gateway-core.config.ts src/gateway/server/plugins-http.post-auth-chat.test.ts src/gateway/server/plugins-http.bound-chat-lazy.test.ts src/gateway/server/plugins-http.runtime-scopes.test.ts`
  3 files, 59 passed. Log: `.artifacts/metadata-green-gateway.log`.
- `node scripts/run-vitest.mjs run --config test/vitest/vitest.gateway-methods.config.ts src/gateway/server-methods/chat.directive-tags.test.ts -t 'post-auth|bound-chat'`
  1 file, 5 passed / 134 skipped. Includes large in-process attachment and real hook/admission checks. Log: `.artifacts/metadata-green-real-chat.log`.

These tests preceded final formatter changes and an explicit optional-value narrowing in the new installed-index test. Final test/core typechecks and lint below ran after those edits; tests were not rerun afterward.

Final typechecks, both exit 0:

- `node scripts/run-tsgo.mjs -p test/tsconfig/tsconfig.core.test.json --incremental --tsBuildInfoFile .artifacts/tsgo-cache/core-test.tsbuildinfo`
- `node scripts/run-tsgo.mjs -p tsconfig.core.json --incremental --tsBuildInfoFile .artifacts/tsgo-cache/core.tsbuildinfo`

Intermediate test-type attempts caught optional installed-index return fields in the newly added test; explicit narrowing fixed them. The original string-array type incompatibility is resolved without changing its fixture.

Scoped lint, exit 0 with preparation enabled (no skip-preparation or skip-lock override):

`node scripts/run-oxlint.mjs --tsconfig tsconfig.core.json` followed by every TypeScript path listed below. Log: `.artifacts/metadata-lint.log`.

Formatter applied successfully:

`node_modules/.bin/oxfmt --write --threads=1` followed by the report and every TypeScript path listed below. Exit 0, 16 files. A post-write format check was not run; the report was subsequently rewritten with these results.

SDK checks/generation completed with a 600-second command budget, all exit 0:

- `node scripts/sync-plugin-sdk-exports.mjs --check` (`plugin-sdk:check-exports`).
- `node --max-old-space-size=8192 scripts/plugin-sdk-surface-report.mjs --check` (`plugin-sdk:surface:check`). 324 public entrypoints, 10466 public exports, 5222 callable exports; no budget increase.
- `node --max-old-space-size=8192 --import tsx scripts/generate-plugin-sdk-api-baseline.ts --write` (`plugin-sdk:api:gen`).
- `node --max-old-space-size=8192 --import tsx scripts/generate-plugin-sdk-api-baseline.ts --check` (`plugin-sdk:api:check`): `OK docs/.generated/plugin-sdk-api-baseline.sha256`.

Exact generator outputs:

- `docs/.generated/plugin-sdk-api-baseline.sha256` (tracked baseline target).
- `docs/.generated/plugin-sdk-api-baseline.json` (gitignored local artifact).
- `docs/.generated/plugin-sdk-api-baseline.jsonl` (gitignored local artifact).

Hashes were not hand-edited. The generator wrote these files and its subsequent check passed. A final Git diff was not taken, so no claim is made that the tracked hash content differs from base.

## Worktree files and remaining proof

Source/report paths changed across the uncommitted spike:

- `POST_AUTH_CHAT_SPIKE.md`
- `src/gateway/server-methods.ts`
- `src/gateway/server-methods/chat.directive-tags.test.ts`
- `src/gateway/server-methods/chat.ts`
- `src/gateway/server-plugins.ts`
- `src/gateway/server/plugins-http.post-auth-chat.test.ts`
- `src/gateway/server/plugins-http.bound-chat-lazy.test.ts`
- `src/plugins/api-builder.ts`
- `src/plugins/installed-plugin-index.test.ts`
- `src/plugins/manifest.json5-tolerance.test.ts`
- `src/plugins/manifest.ts`
- `src/plugins/post-auth-chat.ts`
- `src/plugins/registry-lifecycle.ts`
- `src/plugins/registry-types.ts`
- `src/plugins/registry.ts`
- `src/plugins/types.ts`

The tracked baseline target listed above was additionally generated. Its changed/unchanged Git status still needs confirmation. Existing intent-to-add entries were preserved; no staging or commits were performed.

Runtime budget ended after final SDK/type/lint verification. Not completed: explicit build/package/declaration gate, post-format test rerun, final format check after report rewrite, and final `git diff --check`/status. Preparation-enabled lint is not a substitute for explicit build/package proof. Previous clean diff evidence must not be presented as a final check for this slice.

Recommendation: keep the corrected metadata/API local spike. String-array metadata is compatible with the primitive; no widening is necessary. Do not deploy. Production grant provenance/configuration/revocation, canonical session-store target binding, and durable recovery ownership remain separately scoped work.

No commits, pushes, PRs, issues, remotes, hosts, services, credentials, live installs, production grant/config changes, or Colony integration were performed.
