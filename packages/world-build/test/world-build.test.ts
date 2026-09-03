import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FIREDRILL_ENGINE_VERSION } from "@firedrill/contracts";
import {
  BuildIdentitySchema,
  BuildManifestSchema,
  CanonicalWorldIrSchema,
  PackageLockSchema,
  semanticHash,
  sha256Text,
} from "@firedrill/world-ir";
import { afterEach, describe, expect, it } from "vitest";
import { loadWorldBuild } from "../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    if (directory.startsWith(`${tmpdir()}/firedrill-world-build-`)) {
      rmSync(directory, { force: true, recursive: true });
    }
  }
});

function createBuild(behavior = 'export default {operations:{"records.read":()=>({value:1})}};') {
  const directory = mkdtempSync(join(tmpdir(), "firedrill-world-build-"));
  temporaryDirectories.push(directory);
  const manifest = {
    schemaVersion: 1,
    id: "record-store",
    version: "1.0.0",
    engine: ">=0.1.0 <0.2.0",
    capabilities: [],
    operations: [
      {
        id: "records.read",
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        idempotency: "none",
        fidelity: "contract",
      },
    ],
  } as const;
  const worldIr = CanonicalWorldIrSchema.parse({
    schemaVersion: 1,
    engineVersion: FIREDRILL_ENGINE_VERSION,
    world: { id: "record-world", seed: "7" },
    tools: [manifest],
    baseline: {
      virtualTimeUs: 0,
      actors: [
        {
          id: "reader",
          grants: [{ packageId: "record-store", operationId: "records.read" }],
        },
      ],
    },
  });
  const bytes = Buffer.from(behavior);
  const artifactHash = sha256Text(bytes);
  const artifactPath = `tools/record-store-${artifactHash.slice(7, 31)}.mjs`;
  const packageLock = PackageLockSchema.parse({
    schemaVersion: 1,
    engineVersion: FIREDRILL_ENGINE_VERSION,
    packages: [
      {
        packageId: "record-store",
        version: "1.0.0",
        manifestHash: semanticHash(worldIr.tools[0]),
        artifactHash,
        artifactPath,
        exportName: "default",
        moduleFormat: "esm",
        source: { kind: "repository" },
      },
    ],
  });
  const provenance = [
    { kind: "tool", id: "record-store", contentHash: semanticHash({ manifest, artifactHash }) },
    { kind: "world", id: "record-world", contentHash: semanticHash(worldIr.baseline) },
  ] as const;
  const identity = BuildIdentitySchema.parse({
    schemaVersion: 1,
    worldIrSchemaVersion: 1,
    packageLockSchemaVersion: 1,
    compilerVersion: "0.1.0",
    engineVersion: FIREDRILL_ENGINE_VERSION,
    irHash: semanticHash(worldIr),
    packageLockHash: semanticHash(packageLock),
    sourceDigest: semanticHash(provenance),
  });
  const buildManifest = BuildManifestSchema.parse({
    ...identity,
    buildHash: semanticHash(identity),
    worldId: "record-world",
    artifacts: { worldIr: "world.ir.json", packageLock: "packages.lock.json" },
    provenance,
    diagnostics: { errors: 0, warnings: 0, info: 0 },
  });
  const writeJson = (path: string, value: unknown) =>
    writeFileSync(join(directory, path), `${JSON.stringify(value)}\n`);
  mkdirSync(dirname(join(directory, artifactPath)), { recursive: true });
  writeJson("build.json", buildManifest);
  writeJson("world.ir.json", worldIr);
  writeJson("packages.lock.json", packageLock);
  writeFileSync(join(directory, artifactPath), bytes);
  return { directory, artifactPath };
}

describe("verified world build loading", () => {
  it("loads an exact locked Tool behavior artifact", async () => {
    const fixture = createBuild();
    const loaded = await loadWorldBuild(fixture.directory);
    expect(loaded.status).toBe("success");
    if (loaded.status === "success") {
      expect(loaded.build.tools[0]?.manifest.id).toBe("record-store");
      expect(loaded.build.tools[0]?.operations["records.read"]?.({}, {} as never)).toEqual({ value: 1 });
    }
  });

  it("rejects changed bytes and unexpected files before loading code", async () => {
    const tampered = createBuild();
    writeFileSync(join(tampered.directory, tampered.artifactPath), "export default {};");
    const hashFailure = await loadWorldBuild(tampered.directory);
    expect(hashFailure.status).toBe("failed");
    if (hashFailure.status === "failed") {
      expect(hashFailure.diagnostics.map((item) => item.code)).toContain("FD1602");
    }

    const extra = createBuild();
    writeFileSync(join(extra.directory, "unexpected.txt"), "not locked");
    const setFailure = await loadWorldBuild(extra.directory);
    expect(setFailure.status).toBe("failed");
    if (setFailure.status === "failed") {
      expect(setFailure.diagnostics.map((item) => item.code)).toContain("FD1602");
    }
  });

  it("rejects behavior whose handlers do not match the locked manifest", async () => {
    const fixture = createBuild('export default {operations:{"records.delete":()=>({})}};');
    const loaded = await loadWorldBuild(fixture.directory);
    expect(loaded.status).toBe("failed");
    if (loaded.status === "failed") {
      expect(loaded.diagnostics.map((item) => item.code)).toContain("FD1603");
      expect(loaded.diagnostics[0]?.message).toMatch(/handlers do not match/);
    }
  });

  it("rejects an unknown generated-build schema version without loading Tool code", async () => {
    const fixture = createBuild('throw new Error("Tool code must not load");');
    const manifestPath = join(fixture.directory, "build.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, schemaVersion: 2 })}\n`);

    const loaded = await loadWorldBuild(fixture.directory);
    expect(loaded.status).toBe("failed");
    if (loaded.status === "failed") {
      expect(loaded.diagnostics).toEqual([
        expect.objectContaining({
          code: "FD1604",
          message: "unsupported build manifest schemaVersion 2; this release supports 1",
          suggestion: expect.stringContaining("must not be edited or relabeled"),
        }),
      ]);
    }
  });
});
