import { generateKeyPairSync, sign } from "node:crypto";
import {
  canonicalJson,
  EvidenceAttestationEnvelopeSchema,
  type EvidenceBundleManifest,
} from "@firedrill/contracts";
import { describe, expect, it } from "vitest";
import {
  createEvidenceAttestationStatement,
  EvidenceAttestationVerificationError,
  evidenceVerificationKeyFingerprint,
  verifyEvidenceAttestation,
} from "../src/index.js";

const HASH = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const ISSUED_AT_MS = 1_800_000_000_000;

function manifest(): EvidenceBundleManifest {
  return {
    schemaVersion: 1,
    runId: "run_attest001",
    complete: true,
    runResultHash: HASH,
    evidenceHash: HASH_B,
    stateHash: HASH,
    trajectoryHash: HASH_B,
    projectedRunResultHash: HASH,
    projectedEvidenceHash: HASH_B,
    projectedTrajectoryHash: HASH_B,
    redaction: { policy: "safe_fields_v2", applied: false, replacements: 0 },
    reproduction: {
      schemaVersion: 1,
      scope: "world_inputs",
      drillId: "settle-record",
      scenarioId: "baseline",
      targetId: "agent-under-test",
      buildHash: HASH,
      packageLockHash: HASH_B,
      seed: "42",
      originalTrial: 1,
      originalTrialCount: 1,
      originalAttempt: 1,
      originalAttemptLimit: 1,
    },
    tools: [],
    artifacts: [
      {
        path: "run.json",
        mediaType: "application/json",
        bytes: 2,
        hash: HASH,
        role: "run",
      },
    ],
  };
}

function fixture() {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicKeyPem = pair.publicKey.export({ format: "pem", type: "spki" }).toString();
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest(), null, 2)}\n`);
  const statement = createEvidenceAttestationStatement({
    issuer: "https://api.firedrill.run",
    keyId: "evidence-2026-09-v1",
    issuedAtMs: ISSUED_AT_MS,
    manifestBytes,
  });
  const signature = sign("sha256", Buffer.from(canonicalJson(statement as never)), pair.privateKey).toString(
    "base64url",
  );
  const envelope = EvidenceAttestationEnvelopeSchema.parse({
    schemaVersion: 1,
    algorithm: "ecdsa-p256-sha256",
    encoding: "der-base64url",
    statement,
    signature,
  });
  const key = {
    schemaVersion: 1 as const,
    issuer: statement.issuer,
    keyId: statement.keyId,
    algorithm: "ecdsa-p256-sha256" as const,
    publicKeyPem,
    fingerprint: evidenceVerificationKeyFingerprint(publicKeyPem),
    status: "active" as const,
    validFromMs: ISSUED_AT_MS - 1,
  };
  return { envelope, key, manifestBytes };
}

describe("evidence attestations", () => {
  it("verifies the signature, trust record, exact manifest bytes, and semantic subject", () => {
    const value = fixture();
    expect(verifyEvidenceAttestation({ ...value, nowMs: ISSUED_AT_MS + 1 })).toMatchObject({
      manifest: { runId: "run_attest001" },
      key: { status: "active" },
    });
  });

  it("rejects a different manifest even when it remains valid JSON", () => {
    const value = fixture();
    const changed = Buffer.from(`${JSON.stringify({ ...manifest(), evidenceHash: HASH }, null, 2)}\n`);
    expect(() =>
      verifyEvidenceAttestation({ ...value, manifestBytes: changed, nowMs: ISSUED_AT_MS + 1 }),
    ).toThrowError(EvidenceAttestationVerificationError);
  });

  it("rejects revoked, mismatched, and cryptographically invalid trust material", () => {
    const value = fixture();
    expect(() =>
      verifyEvidenceAttestation({
        ...value,
        key: { ...value.key, status: "revoked", revokedAtMs: ISSUED_AT_MS + 1 },
        nowMs: ISSUED_AT_MS + 1,
      }),
    ).toThrow(/revoked/);
    expect(() =>
      verifyEvidenceAttestation({
        ...value,
        key: { ...value.key, issuer: "https://other.example" },
        nowMs: ISSUED_AT_MS + 1,
      }),
    ).toThrow(/does not match/);
    expect(() =>
      verifyEvidenceAttestation({
        ...value,
        envelope: { ...value.envelope, signature: value.envelope.signature.replace(/^./, "A") },
        nowMs: ISSUED_AT_MS + 1,
      }),
    ).toThrow(/signature is invalid/);
  });
});
