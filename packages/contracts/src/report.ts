import { z } from "zod";
import { RunIdSchema, SeedSchema, Sha256Schema, StableIdSchema } from "./identifiers.js";

const RelativeArtifactPathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => !value.startsWith("/") && !value.includes("\\") && !value.split("/").includes(".."), {
    message: "artifact path must be relative to the evidence bundle",
  });

export const ReportArtifactSchema = z
  .object({
    path: RelativeArtifactPathSchema,
    mediaType: z.string().min(1).max(200),
    bytes: z.number().int().nonnegative().safe(),
    hash: Sha256Schema,
    role: z.enum(["run", "evidence", "state_diff", "terminal", "json", "junit", "html", "attachment"]),
  })
  .strict();

export const ReportRedactionSchema = z
  .object({
    policy: z.literal("safe_fields_v2"),
    applied: z.boolean(),
    replacements: z.number().int().nonnegative().safe(),
  })
  .strict()
  .refine((redaction) => redaction.applied === redaction.replacements > 0, {
    path: ["applied"],
    message: "applied must reflect whether any values were replaced",
  });

export const ReproductionDescriptorSchema = z
  .object({
    schemaVersion: z.literal(1),
    scope: z.literal("world_inputs"),
    drillId: StableIdSchema,
    scenarioId: StableIdSchema.optional(),
    targetId: StableIdSchema,
    buildHash: Sha256Schema,
    packageLockHash: Sha256Schema,
    seed: SeedSchema,
    originalTrial: z.number().int().positive().safe(),
    originalTrialCount: z.number().int().positive().safe(),
    originalAttempt: z.number().int().positive().safe().default(1),
    originalAttemptLimit: z.number().int().positive().safe().default(1),
  })
  .strict()
  .refine((descriptor) => descriptor.originalTrial <= descriptor.originalTrialCount, {
    path: ["originalTrial"],
    message: "originalTrial cannot exceed originalTrialCount",
  })
  .refine((descriptor) => descriptor.originalAttempt <= descriptor.originalAttemptLimit, {
    path: ["originalAttempt"],
    message: "originalAttempt cannot exceed originalAttemptLimit",
  });

export const EvidenceBundleManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: RunIdSchema,
    complete: z.boolean(),
    /** Hashes of the unredacted runtime values. They link the report to the sealed run. */
    runResultHash: Sha256Schema,
    evidenceHash: Sha256Schema,
    stateHash: Sha256Schema.optional(),
    trajectoryHash: Sha256Schema.optional(),
    /** Hashes of the redacted values actually carried by this portable bundle. */
    projectedRunResultHash: Sha256Schema,
    projectedEvidenceHash: Sha256Schema,
    projectedTrajectoryHash: Sha256Schema.optional(),
    redaction: ReportRedactionSchema,
    reproduction: ReproductionDescriptorSchema,
    artifacts: z.array(ReportArtifactSchema).min(1),
  })
  .passthrough()
  .superRefine((manifest, context) => {
    const paths = new Set<string>();
    for (const [index, artifact] of manifest.artifacts.entries()) {
      if (paths.has(artifact.path)) {
        context.addIssue({
          code: "custom",
          path: ["artifacts", index, "path"],
          message: "duplicate artifact path",
        });
      }
      paths.add(artifact.path);
    }
    if ((manifest.trajectoryHash === undefined) !== (manifest.projectedTrajectoryHash === undefined)) {
      context.addIssue({
        code: "custom",
        path: ["projectedTrajectoryHash"],
        message: "source and projected trajectory hashes must be present together",
      });
    }
  });

export type EvidenceBundleManifest = z.infer<typeof EvidenceBundleManifestSchema>;
export type ReportArtifact = z.infer<typeof ReportArtifactSchema>;
export type ReportRedaction = z.infer<typeof ReportRedactionSchema>;
export type ReproductionDescriptor = z.infer<typeof ReproductionDescriptorSchema>;
