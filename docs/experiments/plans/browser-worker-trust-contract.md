---
summary: "Spec baseline for browser/worker trust authority, signed heartbeat refresh, and recovery"
read_when:
  - Implementing the SPAZ-126 worker trust and heartbeat contract
  - Reconciling browser controller / relay worker authority boundaries
title: "Browser Worker Trust Contract"
---

# Browser Worker Trust Contract

Status: draft implementation baseline for `SPAZ-126`.

This contract is intentionally **control-plane only**. It does not authorize
real worker activation, production credential issuance, unrelated restarts, or
distributed-inference claims.

## Merged controller baseline

Current controller baseline already has:

- loopback bind for local browser control
- bearer/password auth on HTTP bridge surfaces
- path guards for output/upload traversal
- `browser.evaluateEnabled=false` gating for `act:evaluate`

What it did **not** have before this slice:

- explicit `pending -> approved -> revoked` worker authority
- signed heartbeat plus manifest refresh verification
- replay bounds
- key-loss recovery semantics
- a contract-level shell execution ban for worker manifests

## Contract

Worker trust is modeled as a small state machine:

1. `pending`
2. `approved`
3. `revoked`

Rules:

- A worker starts `pending`.
- Only `approved` workers may send accepted heartbeats.
- Key-loss recovery demotes the worker back to `pending` and increments the
  approval epoch.
- Revocation clears active key material and rejects all future heartbeats until
  an explicit re-approval flow happens.

## Signed heartbeat / manifest refresh

Each heartbeat carries:

- `workerId`
- `keyId`
- `approvalEpoch`
- `nonce`
- `issuedAt`
- `expiresAt`
- signed manifest snapshot
- HMAC-SHA256 signature over a stable canonical payload

Validation rules:

- worker must currently be `approved`
- `workerId`, `keyId`, and `approvalEpoch` must match the approved record
- signature must verify against the approved key
- TTL must stay within the bounded window
- expired or future-skewed heartbeats are rejected
- nonce replay inside the active window is rejected
- manifest version must be monotonic
- manifest refresh may stay equal or narrower, but may not widen capabilities

## No arbitrary shell execution

Worker manifests may not advertise shell-like capabilities. Current deny set:

- `bash`
- `exec`
- `process`
- `shell`
- `system.run`
- `terminal`

If we later want tighter mutation boundaries than shell execution alone, extend
the deny set at the contract layer before wiring live paths.

## Threat model

Primary threats covered by this baseline:

1. Stolen old heartbeat replay within a later session
2. Manifest widening after approval without human authority
3. Compromised or lost worker key continuing to authenticate
4. Controller trust drift where local HTTP auth exists but worker authority does not
5. Worker claiming shell access through a manifest refresh

Still out of scope here:

1. Secure operator UX for approval issuance
2. Durable storage / replication of trust state across processes
3. Hardware-backed keys or asymmetric signatures
4. Live worker activation plumbing

## Tests

Contract tests now cover:

- pending workers denied
- approved signed heartbeat accepted
- replay denied
- stale manifest refresh denied
- capability widening denied
- key-loss recovery forces re-approval
- revoked worker denied
- expired / overlong heartbeat windows denied
