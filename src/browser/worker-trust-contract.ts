import { createHmac } from "node:crypto";
import { stableStringify } from "../agents/stable-stringify.js";
import { safeEqualSecret } from "../security/secret-equal.js";

const DEFAULT_MAX_CLOCK_SKEW_MS = 30_000;
const DEFAULT_MAX_HEARTBEAT_TTL_MS = 5 * 60_000;
const DISALLOWED_SHELL_CAPABILITIES = new Set([
  "bash",
  "exec",
  "process",
  "shell",
  "system.run",
  "terminal",
]);

export type WorkerTrustStatus = "pending" | "approved" | "revoked";

export type WorkerManifest = {
  manifestVersion: number;
  controllerVersion: string;
  capabilities: string[];
  metadata?: Record<string, unknown>;
};

export type WorkerApprovalKey = {
  keyId: string;
  keySecret: string;
  issuedAt: number;
};

export type WorkerNonceRecord = {
  nonce: string;
  expiresAt: number;
};

export type WorkerTrustRecord = {
  workerId: string;
  status: WorkerTrustStatus;
  approvalEpoch: number;
  requestedManifest: WorkerManifest;
  approvedManifest?: WorkerManifest;
  activeKey?: WorkerApprovalKey;
  recentNonces: WorkerNonceRecord[];
  lastHeartbeatAt?: number;
  lastAcceptedManifestVersion?: number;
  approvedAt?: number;
  revokedAt?: number;
  revokedReason?: string;
  recoveryReason?: string;
};

export type WorkerHeartbeatEnvelope = {
  workerId: string;
  keyId: string;
  approvalEpoch: number;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
  manifest: WorkerManifest;
  signature: string;
};

type WorkerHeartbeatUnsigned = Omit<WorkerHeartbeatEnvelope, "signature">;

export function normalizeWorkerManifest(manifest: WorkerManifest): WorkerManifest {
  const capabilities = Array.from(
    new Set(
      manifest.capabilities
        .map((capability) => capability.trim())
        .filter((capability) => capability.length > 0),
    ),
  ).toSorted();
  return {
    manifestVersion: manifest.manifestVersion,
    controllerVersion: manifest.controllerVersion.trim(),
    capabilities,
    ...(manifest.metadata ? { metadata: manifest.metadata } : {}),
  };
}

export function validateWorkerManifest(manifest: WorkerManifest): void {
  const normalized = normalizeWorkerManifest(manifest);
  if (!Number.isInteger(normalized.manifestVersion) || normalized.manifestVersion < 1) {
    throw new Error("worker manifestVersion must be an integer >= 1");
  }
  if (!normalized.controllerVersion) {
    throw new Error("worker controllerVersion is required");
  }
  if (normalized.capabilities.length === 0) {
    throw new Error("worker capabilities must not be empty");
  }
  const banned = normalized.capabilities.find((capability) =>
    DISALLOWED_SHELL_CAPABILITIES.has(capability),
  );
  if (banned) {
    throw new Error(`worker capability '${banned}' is not allowed`);
  }
}

function ensureManifestSubset(base: WorkerManifest, incoming: WorkerManifest): void {
  const baseNormalized = normalizeWorkerManifest(base);
  const incomingNormalized = normalizeWorkerManifest(incoming);
  const baseCapabilities = new Set(baseNormalized.capabilities);
  const widened = incomingNormalized.capabilities.find(
    (capability) => !baseCapabilities.has(capability),
  );
  if (widened) {
    throw new Error(`worker manifest refresh widens capability '${widened}'`);
  }
}

function pruneRecentNonces(recentNonces: WorkerNonceRecord[], now: number): WorkerNonceRecord[] {
  return recentNonces.filter((entry) => entry.expiresAt > now);
}

function canonicalHeartbeatPayload(payload: WorkerHeartbeatUnsigned): string {
  return stableStringify({
    approvalEpoch: payload.approvalEpoch,
    expiresAt: payload.expiresAt,
    issuedAt: payload.issuedAt,
    keyId: payload.keyId,
    manifest: normalizeWorkerManifest(payload.manifest),
    nonce: payload.nonce,
    workerId: payload.workerId,
  });
}

export function signWorkerHeartbeat(
  payload: WorkerHeartbeatUnsigned,
  keySecret: string,
): WorkerHeartbeatEnvelope {
  const signature = createHmac("sha256", keySecret)
    .update(canonicalHeartbeatPayload(payload))
    .digest("hex");
  return { ...payload, signature };
}

export function createPendingWorkerTrustRecord(params: {
  workerId: string;
  requestedManifest: WorkerManifest;
  now: number;
}): WorkerTrustRecord {
  validateWorkerManifest(params.requestedManifest);
  return {
    workerId: params.workerId,
    status: "pending",
    approvalEpoch: 1,
    requestedManifest: normalizeWorkerManifest(params.requestedManifest),
    recentNonces: [],
  };
}

export function approvePendingWorkerTrust(params: {
  record: WorkerTrustRecord;
  approvedManifest?: WorkerManifest;
  keyId: string;
  keySecret: string;
  now: number;
}): WorkerTrustRecord {
  if (params.record.status !== "pending") {
    throw new Error("worker trust must be pending before approval");
  }
  if (!params.keyId.trim() || !params.keySecret.trim()) {
    throw new Error("worker approval keyId and keySecret are required");
  }
  const approvedManifest = normalizeWorkerManifest(
    params.approvedManifest ?? params.record.requestedManifest,
  );
  validateWorkerManifest(approvedManifest);
  ensureManifestSubset(params.record.requestedManifest, approvedManifest);
  return {
    ...params.record,
    status: "approved",
    approvedManifest,
    activeKey: {
      keyId: params.keyId.trim(),
      keySecret: params.keySecret,
      issuedAt: params.now,
    },
    approvedAt: params.now,
    revokedAt: undefined,
    revokedReason: undefined,
    recoveryReason: undefined,
    recentNonces: [],
    lastAcceptedManifestVersion: approvedManifest.manifestVersion,
  };
}

export function revokeWorkerTrust(params: {
  record: WorkerTrustRecord;
  now: number;
  reason: string;
}): WorkerTrustRecord {
  if (!params.reason.trim()) {
    throw new Error("worker revocation reason is required");
  }
  return {
    ...params.record,
    status: "revoked",
    activeKey: undefined,
    recentNonces: [],
    revokedAt: params.now,
    revokedReason: params.reason.trim(),
  };
}

export function recoverWorkerKeyLoss(params: {
  record: WorkerTrustRecord;
  now: number;
  requestedManifest?: WorkerManifest;
  reason?: string;
}): WorkerTrustRecord {
  if (params.record.status !== "approved") {
    throw new Error("worker key-loss recovery requires an approved worker");
  }
  const requestedManifest = normalizeWorkerManifest(
    params.requestedManifest ?? params.record.approvedManifest ?? params.record.requestedManifest,
  );
  validateWorkerManifest(requestedManifest);
  if (params.record.approvedManifest) {
    ensureManifestSubset(params.record.approvedManifest, requestedManifest);
  }
  return {
    ...params.record,
    status: "pending",
    approvalEpoch: params.record.approvalEpoch + 1,
    requestedManifest,
    approvedManifest: undefined,
    activeKey: undefined,
    recentNonces: [],
    revokedAt: undefined,
    revokedReason: undefined,
    recoveryReason: params.reason?.trim() || "key_loss",
    approvedAt: undefined,
    lastAcceptedManifestVersion: undefined,
  };
}

export function verifyWorkerHeartbeat(params: {
  record: WorkerTrustRecord;
  envelope: WorkerHeartbeatEnvelope;
  now: number;
  maxClockSkewMs?: number;
  maxHeartbeatTtlMs?: number;
}): WorkerTrustRecord {
  const maxClockSkewMs = params.maxClockSkewMs ?? DEFAULT_MAX_CLOCK_SKEW_MS;
  const maxHeartbeatTtlMs = params.maxHeartbeatTtlMs ?? DEFAULT_MAX_HEARTBEAT_TTL_MS;
  const record = params.record;
  const envelope = params.envelope;

  if (record.status !== "approved") {
    throw new Error(`worker '${record.workerId}' is not approved`);
  }
  if (!record.activeKey || !record.approvedManifest) {
    throw new Error(`worker '${record.workerId}' is missing active approval material`);
  }
  if (record.workerId !== envelope.workerId) {
    throw new Error("worker heartbeat workerId mismatch");
  }
  if (record.activeKey.keyId !== envelope.keyId) {
    throw new Error("worker heartbeat keyId mismatch");
  }
  if (record.approvalEpoch !== envelope.approvalEpoch) {
    throw new Error("worker heartbeat approval epoch mismatch");
  }
  if (!envelope.nonce.trim()) {
    throw new Error("worker heartbeat nonce is required");
  }
  if (!Number.isInteger(envelope.issuedAt) || !Number.isInteger(envelope.expiresAt)) {
    throw new Error("worker heartbeat issuedAt/expiresAt must be integers");
  }
  if (envelope.expiresAt <= envelope.issuedAt) {
    throw new Error("worker heartbeat expiresAt must be after issuedAt");
  }
  if (envelope.expiresAt - envelope.issuedAt > maxHeartbeatTtlMs) {
    throw new Error("worker heartbeat ttl exceeds allowed maximum");
  }
  if (envelope.issuedAt > params.now + maxClockSkewMs) {
    throw new Error("worker heartbeat issuedAt is too far in the future");
  }
  if (params.now > envelope.expiresAt) {
    throw new Error("worker heartbeat is expired");
  }

  validateWorkerManifest(envelope.manifest);
  ensureManifestSubset(record.approvedManifest, envelope.manifest);
  if (
    typeof record.lastAcceptedManifestVersion === "number" &&
    envelope.manifest.manifestVersion < record.lastAcceptedManifestVersion
  ) {
    throw new Error("worker manifest refresh is stale");
  }

  const expected = signWorkerHeartbeat(
    {
      workerId: envelope.workerId,
      keyId: envelope.keyId,
      approvalEpoch: envelope.approvalEpoch,
      nonce: envelope.nonce,
      issuedAt: envelope.issuedAt,
      expiresAt: envelope.expiresAt,
      manifest: envelope.manifest,
    },
    record.activeKey.keySecret,
  );
  if (!safeEqualSecret(envelope.signature, expected.signature)) {
    throw new Error("worker heartbeat signature mismatch");
  }

  const recentNonces = pruneRecentNonces(record.recentNonces, params.now);
  if (recentNonces.some((entry) => entry.nonce === envelope.nonce)) {
    throw new Error("worker heartbeat replay detected");
  }

  return {
    ...record,
    recentNonces: [...recentNonces, { nonce: envelope.nonce, expiresAt: envelope.expiresAt }],
    lastHeartbeatAt: params.now,
    lastAcceptedManifestVersion: Math.max(
      record.lastAcceptedManifestVersion ?? 0,
      envelope.manifest.manifestVersion,
    ),
  };
}
