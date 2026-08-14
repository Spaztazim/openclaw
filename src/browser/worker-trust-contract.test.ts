import { describe, expect, it } from "vitest";
import {
  approvePendingWorkerTrust,
  createPendingWorkerTrustRecord,
  recoverWorkerKeyLoss,
  revokeWorkerTrust,
  signWorkerHeartbeat,
  verifyWorkerHeartbeat,
} from "./worker-trust-contract.js";

const BASE_MANIFEST = {
  manifestVersion: 1,
  controllerVersion: "controller-merged-baseline",
  capabilities: ["browser.navigate", "browser.snapshot"],
};

describe("worker trust contract", () => {
  it("requires explicit approval before accepting worker heartbeats", () => {
    const record = createPendingWorkerTrustRecord({
      workerId: "worker-a",
      requestedManifest: BASE_MANIFEST,
      now: 1_000,
    });
    const envelope = signWorkerHeartbeat(
      {
        workerId: "worker-a",
        keyId: "key-a",
        approvalEpoch: 1,
        nonce: "nonce-1",
        issuedAt: 1_000,
        expiresAt: 2_000,
        manifest: BASE_MANIFEST,
      },
      "secret-a",
    );
    expect(() =>
      verifyWorkerHeartbeat({
        record,
        envelope,
        now: 1_500,
      }),
    ).toThrow(/not approved/i);
  });

  it("accepts approved signed heartbeats and rejects replay", () => {
    const pending = createPendingWorkerTrustRecord({
      workerId: "worker-a",
      requestedManifest: BASE_MANIFEST,
      now: 1_000,
    });
    const approved = approvePendingWorkerTrust({
      record: pending,
      keyId: "key-a",
      keySecret: "secret-a",
      now: 1_100,
    });
    const envelope = signWorkerHeartbeat(
      {
        workerId: "worker-a",
        keyId: "key-a",
        approvalEpoch: approved.approvalEpoch,
        nonce: "nonce-1",
        issuedAt: 1_200,
        expiresAt: 2_200,
        manifest: BASE_MANIFEST,
      },
      "secret-a",
    );

    const accepted = verifyWorkerHeartbeat({
      record: approved,
      envelope,
      now: 1_300,
    });
    expect(accepted.lastHeartbeatAt).toBe(1_300);
    expect(accepted.recentNonces).toHaveLength(1);

    expect(() =>
      verifyWorkerHeartbeat({
        record: accepted,
        envelope,
        now: 1_350,
      }),
    ).toThrow(/replay/i);
  });

  it("rejects an invalid heartbeat signature", () => {
    const pending = createPendingWorkerTrustRecord({
      workerId: "worker-a",
      requestedManifest: BASE_MANIFEST,
      now: 1_000,
    });
    const approved = approvePendingWorkerTrust({
      record: pending,
      keyId: "key-a",
      keySecret: "secret-a",
      now: 1_100,
    });
    const envelope = signWorkerHeartbeat(
      {
        workerId: "worker-a",
        keyId: "key-a",
        approvalEpoch: approved.approvalEpoch,
        nonce: "nonce-invalid-signature",
        issuedAt: 1_200,
        expiresAt: 2_200,
        manifest: BASE_MANIFEST,
      },
      "wrong-secret",
    );

    expect(() => verifyWorkerHeartbeat({ record: approved, envelope, now: 1_300 })).toThrow(
      /signature mismatch/i,
    );
  });

  it("rejects stale manifest refresh after a newer manifest version was accepted", () => {
    const pending = createPendingWorkerTrustRecord({
      workerId: "worker-a",
      requestedManifest: BASE_MANIFEST,
      now: 1_000,
    });
    const approved = approvePendingWorkerTrust({
      record: pending,
      keyId: "key-a",
      keySecret: "secret-a",
      now: 1_100,
    });
    const refreshed = verifyWorkerHeartbeat({
      record: approved,
      envelope: signWorkerHeartbeat(
        {
          workerId: "worker-a",
          keyId: "key-a",
          approvalEpoch: approved.approvalEpoch,
          nonce: "nonce-2",
          issuedAt: 1_200,
          expiresAt: 2_200,
          manifest: {
            ...BASE_MANIFEST,
            manifestVersion: 2,
          },
        },
        "secret-a",
      ),
      now: 1_250,
    });

    expect(() =>
      verifyWorkerHeartbeat({
        record: refreshed,
        envelope: signWorkerHeartbeat(
          {
            workerId: "worker-a",
            keyId: "key-a",
            approvalEpoch: approved.approvalEpoch,
            nonce: "nonce-3",
            issuedAt: 1_260,
            expiresAt: 2_260,
            manifest: BASE_MANIFEST,
          },
          "secret-a",
        ),
        now: 1_300,
      }),
    ).toThrow(/stale/i);
  });

  it("rejects manifest refreshes that widen capabilities or include shell execution", () => {
    const pending = createPendingWorkerTrustRecord({
      workerId: "worker-a",
      requestedManifest: BASE_MANIFEST,
      now: 1_000,
    });
    const approved = approvePendingWorkerTrust({
      record: pending,
      keyId: "key-a",
      keySecret: "secret-a",
      now: 1_100,
    });

    expect(() =>
      verifyWorkerHeartbeat({
        record: approved,
        envelope: signWorkerHeartbeat(
          {
            workerId: "worker-a",
            keyId: "key-a",
            approvalEpoch: approved.approvalEpoch,
            nonce: "nonce-4",
            issuedAt: 1_200,
            expiresAt: 2_200,
            manifest: {
              ...BASE_MANIFEST,
              manifestVersion: 2,
              capabilities: [...BASE_MANIFEST.capabilities, "exec"],
            },
          },
          "secret-a",
        ),
        now: 1_300,
      }),
    ).toThrow(/not allowed|widens capability/i);
  });

  it("forces explicit re-approval after key-loss recovery and invalidates the old key", () => {
    const pending = createPendingWorkerTrustRecord({
      workerId: "worker-a",
      requestedManifest: BASE_MANIFEST,
      now: 1_000,
    });
    const approved = approvePendingWorkerTrust({
      record: pending,
      keyId: "key-a",
      keySecret: "secret-a",
      now: 1_100,
    });
    const recovered = recoverWorkerKeyLoss({
      record: approved,
      now: 1_400,
    });

    expect(recovered.status).toBe("pending");
    expect(recovered.approvalEpoch).toBe(approved.approvalEpoch + 1);

    const oldEnvelope = signWorkerHeartbeat(
      {
        workerId: "worker-a",
        keyId: "key-a",
        approvalEpoch: approved.approvalEpoch,
        nonce: "nonce-5",
        issuedAt: 1_500,
        expiresAt: 2_500,
        manifest: BASE_MANIFEST,
      },
      "secret-a",
    );
    expect(() =>
      verifyWorkerHeartbeat({
        record: recovered,
        envelope: oldEnvelope,
        now: 1_600,
      }),
    ).toThrow(/not approved/i);

    const reapproved = approvePendingWorkerTrust({
      record: recovered,
      keyId: "key-b",
      keySecret: "secret-b",
      now: 1_700,
    });
    const newEnvelope = signWorkerHeartbeat(
      {
        workerId: "worker-a",
        keyId: "key-b",
        approvalEpoch: reapproved.approvalEpoch,
        nonce: "nonce-6",
        issuedAt: 1_800,
        expiresAt: 2_800,
        manifest: BASE_MANIFEST,
      },
      "secret-b",
    );
    const accepted = verifyWorkerHeartbeat({
      record: reapproved,
      envelope: newEnvelope,
      now: 1_850,
    });
    expect(accepted.lastHeartbeatAt).toBe(1_850);
  });

  it("denies revoked workers even with a valid signature", () => {
    const pending = createPendingWorkerTrustRecord({
      workerId: "worker-a",
      requestedManifest: BASE_MANIFEST,
      now: 1_000,
    });
    const approved = approvePendingWorkerTrust({
      record: pending,
      keyId: "key-a",
      keySecret: "secret-a",
      now: 1_100,
    });
    const revoked = revokeWorkerTrust({
      record: approved,
      now: 1_200,
      reason: "manual revoke",
    });

    const envelope = signWorkerHeartbeat(
      {
        workerId: "worker-a",
        keyId: "key-a",
        approvalEpoch: approved.approvalEpoch,
        nonce: "nonce-7",
        issuedAt: 1_210,
        expiresAt: 2_210,
        manifest: BASE_MANIFEST,
      },
      "secret-a",
    );

    expect(() =>
      verifyWorkerHeartbeat({
        record: revoked,
        envelope,
        now: 1_300,
      }),
    ).toThrow(/not approved/i);
  });

  it("rejects expired or overlong heartbeat windows", () => {
    const pending = createPendingWorkerTrustRecord({
      workerId: "worker-a",
      requestedManifest: BASE_MANIFEST,
      now: 1_000,
    });
    const approved = approvePendingWorkerTrust({
      record: pending,
      keyId: "key-a",
      keySecret: "secret-a",
      now: 1_100,
    });

    expect(() =>
      verifyWorkerHeartbeat({
        record: approved,
        envelope: signWorkerHeartbeat(
          {
            workerId: "worker-a",
            keyId: "key-a",
            approvalEpoch: approved.approvalEpoch,
            nonce: "nonce-8",
            issuedAt: 1_200,
            expiresAt: 10_000,
            manifest: BASE_MANIFEST,
          },
          "secret-a",
        ),
        now: 1_300,
        maxHeartbeatTtlMs: 1_000,
      }),
    ).toThrow(/ttl exceeds/i);

    expect(() =>
      verifyWorkerHeartbeat({
        record: approved,
        envelope: signWorkerHeartbeat(
          {
            workerId: "worker-a",
            keyId: "key-a",
            approvalEpoch: approved.approvalEpoch,
            nonce: "nonce-9",
            issuedAt: 1_200,
            expiresAt: 1_250,
            manifest: BASE_MANIFEST,
          },
          "secret-a",
        ),
        now: 1_300,
      }),
    ).toThrow(/expired/i);
  });
});
