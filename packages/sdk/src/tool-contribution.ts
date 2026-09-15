import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Sha256 } from "@firedrill/contracts";
import { compareStableStrings } from "@firedrill/contracts";
import { FiredrillProjectError } from "./project-error.js";
import type { TestToolOptions, ToolConformanceResult } from "./tool-authoring.js";
import { inspectTool, testTool } from "./tool-authoring.js";

const MAX_SOURCE_FILE_BYTES = 10 * 1024 * 1024;
const MAX_SOURCE_TOTAL_BYTES = 25 * 1024 * 1024;

export interface PrepareToolContributionOptions extends TestToolOptions {
  /** Explicit rights, customer-data review, and Apache-2.0 license attestation. */
  readonly acceptApache2: boolean;
  /** Must not exist. Defaults to .firedrill/contributions/<tool-id>. */
  readonly outputDirectory?: string;
}

export interface ToolContributionBundle {
  readonly schemaVersion: 1;
  readonly directory: string;
  readonly files: readonly string[];
  readonly sourceFiles: readonly {
    readonly path: string;
    readonly bytes: number;
    readonly hash: Sha256;
  }[];
  readonly conformance: {
    readonly suiteId: string;
    readonly deterministic: true;
    readonly drillIds: readonly string[];
  };
}

function hash(bytes: Uint8Array | string): Sha256 {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function contained(parent: string, child: string): boolean {
  const candidate = relative(parent, child);
  return (
    candidate === "" || (!candidate.startsWith(`..${sep}`) && candidate !== ".." && !isAbsolute(candidate))
  );
}

function unsafeSource(path: string, bytes: Buffer, verifiedBinaryUi = false): readonly string[] {
  const issues: string[] = [];
  if (bytes.length > MAX_SOURCE_FILE_BYTES) issues.push("source file exceeds 10 MiB");
  if (bytes.includes(0) && !verifiedBinaryUi) issues.push("binary source is not accepted");
  if (/(^|\/)\.env(?:\.|$)/i.test(path) || /\.(?:key|p12|pfx|pem)$/i.test(path)) {
    issues.push("secret-bearing filename is not accepted");
  }
  const text = bytes.toString("utf8");
  const patterns: readonly [RegExp, string][] = [
    [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, "private key material"],
    [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key"],
    [/\bgithub_pat_[A-Za-z0-9_]{20,}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b/, "GitHub token"],
    [/\bsk-[A-Za-z0-9_-]{20,}\b/, "API key"],
    [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, "Slack token"],
    [/\bAIza[0-9A-Za-z_-]{30,}\b/, "Google API key"],
    [
      /\b(?:api[_-]?key|client[_-]?secret|password|private[_-]?token)\b\s*[:=]\s*["'][^"'\s]{12,}["']/i,
      "credential-like assignment",
    ],
  ];
  for (const [pattern, label] of patterns) {
    if (pattern.test(text)) issues.push(label);
  }
  return issues;
}

function portableConformance(result: ToolConformanceResult) {
  return {
    schemaVersion: 1,
    status: result.status,
    suiteId: result.suiteId,
    deterministic: result.deterministic,
    coverage: result.coverage,
    violations: result.violations,
    runs: result.runs.map((run) => ({
      buildHash: run.buildHash,
      packageLockHash: run.packageLockHash,
      verdict: run.verdict,
      drills: run.drills.map((drill) => ({
        drillId: drill.drillId,
        verdict: drill.verdict,
        trials: drill.trials.map((trial) => ({
          trial: trial.trial,
          seed: trial.seed,
          status: trial.result.status,
          ...(trial.result.status === "sealed"
            ? {
                verdict: trial.result.verdict,
                stateHash: trial.result.stateHash,
                evidenceHash: trial.result.evidenceHash,
                trajectoryHash: trial.result.trajectoryHash,
              }
            : {}),
        })),
      })),
    })),
  };
}

function contributionReadme(input: {
  readonly toolId: string;
  readonly version: string;
  readonly sourceFiles: readonly string[];
  readonly suiteId: string;
}): string {
  return `# ${input.toolId} Tool contribution

Prepared locally by Firedrill for review. No source was uploaded and no pull request was opened.

- Version: ${input.version}
- License offered: Apache-2.0
- Conformance suite: ${input.suiteId}
- Source files copied: ${input.sourceFiles.length}

The contributor explicitly attested that they have the right to contribute these files and reviewed them for secrets and customer data. Automated scanning is a backstop, not a substitute for human review.

The conformance summary contains hashes and coverage only; it intentionally excludes report payloads that may contain private test data. Review the exact files beneath \`source/\` before submission.
`;
}

function writeBundle(directory: string, files: ReadonlyMap<string, Buffer>): readonly string[] {
  for (const [path, bytes] of files) {
    const destination = join(directory, ...path.split("/"));
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, bytes, { flag: "wx" });
  }
  return [...files.keys()].sort(compareStableStrings);
}

function frameworkLegalFile(name: "LICENSE" | "NOTICE"): Buffer {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(moduleDirectory, name), resolve(moduleDirectory, `../../../${name}`)];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (path === undefined) {
    throw new FiredrillProjectError(
      "framework.BUILD_INVALID",
      `the Firedrill SDK installation does not contain ${name}`,
    );
  }
  return readFileSync(path);
}

/**
 * Creates a local, non-overwriting review bundle after successful Tool conformance.
 * This function never uploads source, opens a pull request, or contacts a hosted service.
 */
export async function prepareToolContribution(
  options: PrepareToolContributionOptions,
): Promise<ToolContributionBundle> {
  if (!options.acceptApache2) {
    throw new FiredrillProjectError(
      "framework.TOOL_CONTRIBUTION_ATTESTATION_REQUIRED",
      "contribution preparation requires an explicit Apache-2.0 and source-rights attestation",
    );
  }
  const root = resolve(options.root ?? process.cwd());
  const destination = resolve(
    root,
    options.outputDirectory ?? join(".firedrill", "contributions", options.toolId),
  );
  if (destination === root) {
    throw new FiredrillProjectError(
      "framework.INVALID_ARGUMENT",
      "contribution output cannot be the repository root",
    );
  }
  if (existsSync(destination)) {
    throw new FiredrillProjectError(
      "framework.TOOL_CONTRIBUTION_EXISTS",
      "contribution output already exists; Firedrill will not overwrite it",
      { details: { directory: destination } },
    );
  }

  const inspection = await inspectTool(options);
  if (inspection.origin.kind !== "repository") {
    const sourceLabel =
      inspection.origin.kind === "npm"
        ? `installed package ${inspection.origin.packageName}`
        : `temporary behavior override ${inspection.origin.module}`;
    throw new FiredrillProjectError(
      "framework.TOOL_CONTRIBUTION_SOURCE_REQUIRED",
      `Tool ${inspection.toolId} comes from ${sourceLabel}`,
      {
        details: {
          ...(inspection.origin.kind === "npm"
            ? { packageName: inspection.origin.packageName }
            : { module: inspection.origin.module }),
          suggestion:
            "Prepare a contribution from the Tool's owned source repository, not from a consumer installation.",
        },
      },
    );
  }

  const conformance = await testTool(options);
  if (conformance.status !== "passed") {
    throw new FiredrillProjectError(
      "framework.TOOL_CONFORMANCE_FAILED",
      `Tool ${conformance.tool.toolId} must pass conformance before contribution preparation`,
      {
        details: {
          violations: conformance.violations.map((violation) => ({
            code: violation.code,
            message: violation.message,
            ...(violation.subject === undefined ? {} : { subject: violation.subject }),
            ...(violation.drillId === undefined ? {} : { drillId: violation.drillId }),
            ...(violation.trial === undefined ? {} : { trial: violation.trial }),
          })),
        },
      },
    );
  }

  const sourceFiles: Array<{ path: string; bytes: Buffer; hash: Sha256 }> = [];
  let totalBytes = 0;
  const unsafe: Array<{ path: string; issues: readonly string[] }> = [];
  const uiAssets = new Map(
    conformance.tool.uiSourceFiles.map((path, index) => [path, conformance.tool.artifact.ui?.assets[index]]),
  );
  for (const path of conformance.tool.sourceFiles) {
    const absolute = resolve(root, ...path.split("/"));
    if (!contained(root, absolute)) {
      unsafe.push({ path, issues: ["source escapes the repository"] });
      continue;
    }
    const bytes = readFileSync(absolute);
    totalBytes += bytes.length;
    const asset = uiAssets.get(path);
    const byteHash = hash(bytes);
    const matchesAsset =
      asset !== undefined && asset.bytes === bytes.length && asset.artifactHash === byteHash;
    const binaryUi =
      matchesAsset && /^(?:font\/|image\/)/.test(asset.mediaType) && asset.mediaType !== "image/svg+xml";
    const issues = [...unsafeSource(path, bytes, binaryUi)];
    if (uiAssets.has(path) && !matchesAsset)
      issues.push("UI source changed after conformance; validate and retry");
    if (issues.length > 0) unsafe.push({ path, issues });
    sourceFiles.push({ path, bytes, hash: hash(bytes) });
  }
  if (totalBytes > MAX_SOURCE_TOTAL_BYTES) {
    unsafe.push({ path: "source", issues: ["combined source exceeds 25 MiB"] });
  }
  if (unsafe.length > 0) {
    throw new FiredrillProjectError(
      "framework.TOOL_CONTRIBUTION_UNSAFE",
      "contribution source requires manual cleanup before it can be bundled",
      {
        details: {
          issues: unsafe.map((item) => ({ path: item.path, issues: [...item.issues] })),
        },
      },
    );
  }

  const portable = portableConformance(conformance);
  const contribution = {
    schemaVersion: 1,
    tool: {
      id: conformance.tool.toolId,
      version: conformance.tool.manifest.version,
      manifestHash: conformance.tool.artifact.manifestHash,
      artifactHash: conformance.tool.artifact.artifactHash,
      buildHash: conformance.tool.buildHash,
      packageLockHash: conformance.tool.packageLockHash,
    },
    license: "Apache-2.0",
    attestations: {
      rightToContribute: true,
      reviewedForSecretsAndCustomerData: true,
    },
    sourceFiles: sourceFiles.map((file) => ({ path: file.path, bytes: file.bytes.length, hash: file.hash })),
    conformance: {
      suiteId: conformance.suiteId,
      deterministic: true as const,
      drillIds: conformance.runs[0].selection.drillIds,
    },
  };
  const files = new Map<string, Buffer>();
  files.set(
    "README.md",
    Buffer.from(
      contributionReadme({
        toolId: conformance.tool.toolId,
        version: conformance.tool.manifest.version,
        sourceFiles: conformance.tool.sourceFiles,
        suiteId: conformance.suiteId,
      }),
    ),
  );
  files.set("CONTRIBUTION.json", Buffer.from(`${JSON.stringify(contribution, null, 2)}\n`));
  files.set("manifest.json", Buffer.from(`${JSON.stringify(conformance.tool.manifest, null, 2)}\n`));
  files.set("conformance.json", Buffer.from(`${JSON.stringify(portable, null, 2)}\n`));
  files.set("LICENSE", frameworkLegalFile("LICENSE"));
  files.set("NOTICE", frameworkLegalFile("NOTICE"));
  for (const source of sourceFiles) files.set(`source/${source.path}`, source.bytes);
  const checksums = [...files]
    .map(([path, bytes]) => `${hash(bytes).slice("sha256:".length)}  ${path}`)
    .sort(compareStableStrings);
  files.set("SHA256SUMS", Buffer.from(`${checksums.join("\n")}\n`));

  const parent = dirname(destination);
  mkdirSync(parent, { recursive: true });
  const temporary = mkdtempSync(join(parent, `.${conformance.tool.toolId}-`));
  try {
    const written = writeBundle(temporary, files);
    if (existsSync(destination)) {
      throw new FiredrillProjectError(
        "framework.TOOL_CONTRIBUTION_EXISTS",
        "contribution output appeared while the bundle was being prepared; nothing was overwritten",
        { details: { directory: destination } },
      );
    }
    renameSync(temporary, destination);
    return {
      schemaVersion: 1,
      directory: destination,
      files: written,
      sourceFiles: contribution.sourceFiles,
      conformance: contribution.conformance,
    };
  } catch (error) {
    if (existsSync(temporary) && contained(parent, temporary)) {
      rmSync(temporary, { force: true, recursive: true });
    }
    throw error;
  }
}
