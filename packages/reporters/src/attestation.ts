import { createHash, createPublicKey, type KeyObject, verify } from "node:crypto";
import type {
  EvidenceAttestationEnvelope,
  EvidenceAttestationStatement,
  EvidenceAttestationSubject,
  EvidenceBundleManifest,
  EvidenceVerificationKey,
} from "@firedrill-run/contracts";
import {
  canonicalJson,
  EVIDENCE_ATTESTATION_PREDICATE,
  EvidenceAttestationEnvelopeSchema,
  EvidenceAttestationStatementSchema,
  EvidenceBundleManifestSchema,
  EvidenceVerificationKeySchema,
  Sha256Schema,
} from "@firedrill-run/contracts";

export type EvidenceAttestationVerificationErrorCode =
  | "reporter.ATTESTATION_INVALID"
  | "reporter.ATTESTATION_KEY_UNTRUSTED"
  | "reporter.ATTESTATION_SIGNATURE_INVALID"
  | "reporter.ATTESTATION_SUBJECT_MISMATCH"
  | "reporter.ATTESTATION_TIME_INVALID";

export class EvidenceAttestationVerificationError extends Error {
  constructor(
    readonly code: EvidenceAttestationVerificationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "EvidenceAttestationVerificationError";
  }
}

export interface VerifiedEvidenceAttestation {
  readonly envelope: EvidenceAttestationEnvelope;
  readonly key: EvidenceVerificationKey;
  readonly manifest: EvidenceBundleManifest;
}

export interface VerifyEvidenceAttestationOptions {
  readonly envelope: unknown;
  readonly key: unknown;
  readonly manifestBytes: string | Uint8Array;
  readonly nowMs?: number;
  readonly maximumClockSkewMs?: number;
}

function sha256(value: Uint8Array): `sha256:${string}` {
  return Sha256Schema.parse(
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
  ) as `sha256:${string}`;
}

function bytes(value: string | Uint8Array): Uint8Array {
  return typeof value === "string" ? Buffer.from(value, "utf8") : value;
}

export function evidenceVerificationKeyFingerprint(publicKeyPem: string): `sha256:${string}` {
  try {
    const key = createPublicKey(publicKeyPem);
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
      throw new Error("not a P-256 public key");
    }
    return sha256(key.export({ format: "der", type: "spki" }));
  } catch {
    throw new EvidenceAttestationVerificationError(
      "reporter.ATTESTATION_KEY_UNTRUSTED",
      "evidence verification key is not a valid P-256 public key",
    );
  }
}

export function evidenceAttestationSubject(
  manifest: EvidenceBundleManifest,
  manifestDigest: string,
): EvidenceAttestationSubject {
  return {
    manifestDigest: Sha256Schema.parse(manifestDigest),
    runId: manifest.runId,
    reproduction: manifest.reproduction,
    runResultHash: manifest.runResultHash,
    evidenceHash: manifest.evidenceHash,
    ...(manifest.stateHash === undefined ? {} : { stateHash: manifest.stateHash }),
    ...(manifest.trajectoryHash === undefined ? {} : { trajectoryHash: manifest.trajectoryHash }),
  };
}

export function createEvidenceAttestationStatement(input: {
  readonly issuer: string;
  readonly keyId: string;
  readonly issuedAtMs: number;
  readonly manifestBytes: string | Uint8Array;
}): EvidenceAttestationStatement {
  const manifestBytes = bytes(input.manifestBytes);
  let manifest: EvidenceBundleManifest;
  try {
    manifest = EvidenceBundleManifestSchema.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes)),
    );
  } catch {
    throw new EvidenceAttestationVerificationError(
      "reporter.ATTESTATION_INVALID",
      "evidence manifest is invalid",
    );
  }
  if (!manifest.complete) {
    throw new EvidenceAttestationVerificationError(
      "reporter.ATTESTATION_INVALID",
      "evidence manifest is not complete",
    );
  }
  return EvidenceAttestationStatementSchema.parse({
    schemaVersion: 1,
    predicateType: EVIDENCE_ATTESTATION_PREDICATE,
    issuer: input.issuer,
    keyId: input.keyId,
    issuedAtMs: input.issuedAtMs,
    subject: evidenceAttestationSubject(manifest, sha256(manifestBytes)),
  });
}

export function verifyEvidenceAttestation(
  options: VerifyEvidenceAttestationOptions,
): VerifiedEvidenceAttestation {
  let envelope: EvidenceAttestationEnvelope;
  let key: EvidenceVerificationKey;
  try {
    envelope = EvidenceAttestationEnvelopeSchema.parse(options.envelope);
    key = EvidenceVerificationKeySchema.parse(options.key);
  } catch {
    throw new EvidenceAttestationVerificationError(
      "reporter.ATTESTATION_INVALID",
      "evidence attestation or verification key is invalid",
    );
  }
  if (
    key.issuer !== envelope.statement.issuer ||
    key.keyId !== envelope.statement.keyId ||
    key.algorithm !== envelope.algorithm ||
    evidenceVerificationKeyFingerprint(key.publicKeyPem) !== key.fingerprint
  ) {
    throw new EvidenceAttestationVerificationError(
      "reporter.ATTESTATION_KEY_UNTRUSTED",
      "evidence attestation does not match its verification key",
    );
  }
  if (key.status === "revoked") {
    throw new EvidenceAttestationVerificationError(
      "reporter.ATTESTATION_KEY_UNTRUSTED",
      "evidence verification key is revoked",
    );
  }
  const maximumClockSkewMs = options.maximumClockSkewMs ?? 5 * 60 * 1_000;
  const nowMs = options.nowMs ?? Date.now();
  if (!Number.isSafeInteger(maximumClockSkewMs) || maximumClockSkewMs < 0) {
    throw new TypeError("maximumClockSkewMs must be a non-negative safe integer");
  }
  if (
    envelope.statement.issuedAtMs < key.validFromMs ||
    envelope.statement.issuedAtMs > nowMs + maximumClockSkewMs ||
    (key.retiredAtMs !== undefined && envelope.statement.issuedAtMs > key.retiredAtMs)
  ) {
    throw new EvidenceAttestationVerificationError(
      "reporter.ATTESTATION_TIME_INVALID",
      "evidence attestation was not issued while its key was trusted",
    );
  }
  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey(key.publicKeyPem);
  } catch {
    throw new EvidenceAttestationVerificationError(
      "reporter.ATTESTATION_KEY_UNTRUSTED",
      "evidence verification key cannot be loaded",
    );
  }
  let validSignature = false;
  try {
    validSignature = verify(
      "sha256",
      Buffer.from(canonicalJson(envelope.statement as never)),
      publicKey,
      Buffer.from(envelope.signature, "base64url"),
    );
  } catch {
    validSignature = false;
  }
  if (!validSignature) {
    throw new EvidenceAttestationVerificationError(
      "reporter.ATTESTATION_SIGNATURE_INVALID",
      "evidence attestation signature is invalid",
    );
  }
  const manifestBytes = bytes(options.manifestBytes);
  let manifest: EvidenceBundleManifest;
  try {
    manifest = EvidenceBundleManifestSchema.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes)),
    );
  } catch {
    throw new EvidenceAttestationVerificationError(
      "reporter.ATTESTATION_INVALID",
      "evidence manifest is invalid",
    );
  }
  const expectedSubject = evidenceAttestationSubject(manifest, sha256(manifestBytes));
  if (canonicalJson(expectedSubject as never) !== canonicalJson(envelope.statement.subject as never)) {
    throw new EvidenceAttestationVerificationError(
      "reporter.ATTESTATION_SUBJECT_MISMATCH",
      "evidence attestation does not describe this manifest",
    );
  }
  return { envelope, key, manifest };
}
