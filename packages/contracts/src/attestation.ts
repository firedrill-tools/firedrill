import { z } from "zod";
import { RunIdSchema, Sha256Schema } from "./identifiers.js";
import { ReproductionDescriptorSchema } from "./report.js";

export const EVIDENCE_ATTESTATION_PREDICATE = "https://firedrill.tools/attestations/evidence/v1" as const;

export const EvidenceAttestationKeyIdSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export const EvidenceAttestationSubjectSchema = z
  .object({
    manifestDigest: Sha256Schema,
    runId: RunIdSchema,
    reproduction: ReproductionDescriptorSchema,
    runResultHash: Sha256Schema,
    evidenceHash: Sha256Schema,
    stateHash: Sha256Schema.optional(),
    trajectoryHash: Sha256Schema.optional(),
  })
  .strict();

export const EvidenceAttestationStatementSchema = z
  .object({
    schemaVersion: z.literal(1),
    predicateType: z.literal(EVIDENCE_ATTESTATION_PREDICATE),
    issuer: z.string().url().max(512),
    keyId: EvidenceAttestationKeyIdSchema,
    issuedAtMs: z.number().int().nonnegative().safe(),
    subject: EvidenceAttestationSubjectSchema,
  })
  .strict();

export const EvidenceAttestationEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    algorithm: z.literal("ecdsa-p256-sha256"),
    encoding: z.literal("der-base64url"),
    statement: EvidenceAttestationStatementSchema,
    signature: z
      .string()
      .min(64)
      .max(256)
      .regex(/^[A-Za-z0-9_-]+$/),
  })
  .strict();

export const EvidenceVerificationKeySchema = z
  .object({
    schemaVersion: z.literal(1),
    issuer: z.string().url().max(512),
    keyId: EvidenceAttestationKeyIdSchema,
    algorithm: z.literal("ecdsa-p256-sha256"),
    publicKeyPem: z
      .string()
      .min(100)
      .max(4_096)
      .startsWith("-----BEGIN PUBLIC KEY-----")
      .endsWith("-----END PUBLIC KEY-----\n"),
    fingerprint: Sha256Schema,
    status: z.enum(["active", "retired", "revoked"]),
    validFromMs: z.number().int().nonnegative().safe(),
    retiredAtMs: z.number().int().nonnegative().safe().optional(),
    revokedAtMs: z.number().int().nonnegative().safe().optional(),
  })
  .strict()
  .superRefine((key, context) => {
    if (key.status === "active" && (key.retiredAtMs !== undefined || key.revokedAtMs !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "an active verification key cannot be retired or revoked",
      });
    }
    if (key.status === "retired" && (key.retiredAtMs === undefined || key.revokedAtMs !== undefined)) {
      context.addIssue({ code: "custom", message: "a retired verification key requires retiredAtMs only" });
    }
    if (key.status === "revoked" && key.revokedAtMs === undefined) {
      context.addIssue({ code: "custom", message: "a revoked verification key requires revokedAtMs" });
    }
    if (key.retiredAtMs !== undefined && key.retiredAtMs < key.validFromMs) {
      context.addIssue({
        code: "custom",
        path: ["retiredAtMs"],
        message: "retirement predates key validity",
      });
    }
    if (key.revokedAtMs !== undefined && key.revokedAtMs < key.validFromMs) {
      context.addIssue({
        code: "custom",
        path: ["revokedAtMs"],
        message: "revocation predates key validity",
      });
    }
  });

export type EvidenceAttestationSubject = z.infer<typeof EvidenceAttestationSubjectSchema>;
export type EvidenceAttestationStatement = z.infer<typeof EvidenceAttestationStatementSchema>;
export type EvidenceAttestationEnvelope = z.infer<typeof EvidenceAttestationEnvelopeSchema>;
export type EvidenceVerificationKey = z.infer<typeof EvidenceVerificationKeySchema>;
