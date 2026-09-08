import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { inspectInstalledToolPackage } from "../src/index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "firedrill-inspect-package-"));
  roots.push(root);
  const pack = join(root, "node_modules", "@example", "climate-pack");
  mkdirSync(pack, { recursive: true });
  const metadata = {
    name: "@example/climate-pack",
    version: "2.1.0",
    type: "module",
    exports: { "./package.json": "./package.json" },
    firedrill: { layer: "tool-pack", tool: "climate.tool.json", lifecycle: "active" },
  };
  writeFileSync(join(pack, "package.json"), JSON.stringify(metadata));
  cpSync(
    fileURLToPath(new URL("./fixtures/facility/simulation/climate.tool.json", import.meta.url)),
    join(pack, "climate.tool.json"),
  );
  // Reading the declaration must never load its executable implementation.
  writeFileSync(join(pack, "climate.ts"), 'throw new Error("must never execute during inspection");');
  return {
    root,
    pack,
    metadata,
    inspect: () => inspectInstalledToolPackage({ repositoryRoot: root, packageName: metadata.name }),
  };
}

describe("installed Tool inspection", () => {
  it("reads a package-authored starter and validates it with the world's actual state schema", () => {
    const { pack, metadata, inspect } = fixture();
    writeFileSync(
      join(pack, "package.json"),
      JSON.stringify({ ...metadata, firedrill: { ...metadata.firedrill, starter: "starter.json" } }),
    );
    const state = [
      {
        action: "upsert",
        packageId: "climate-control",
        namespace: "rooms",
        rowId: "lobby",
        value: { celsius: 21 },
      },
    ];
    writeFileSync(join(pack, "starter.json"), JSON.stringify({ schemaVersion: 1, state }));
    expect(inspect()).toMatchObject({
      status: "success",
      starter: { schemaVersion: 1, virtualTimeUs: 0, state },
    });
    for (const row of [
      { ...state[0], packageId: "other-tool" },
      { ...state[0], namespace: "missing" },
      { ...state[0], value: { celsius: "hot" } },
    ]) {
      writeFileSync(join(pack, "starter.json"), JSON.stringify({ schemaVersion: 1, state: [row] }));
      expect(inspect()).toMatchObject({ status: "failed", diagnostics: [{ code: "FD1402" }] });
    }
  });
  it("rejects starter traversal, even internal symlinks, and excessive size", () => {
    const { pack, metadata, inspect } = fixture();
    const setPath = (starter: string) =>
      writeFileSync(
        join(pack, "package.json"),
        JSON.stringify({ ...metadata, firedrill: { ...metadata.firedrill, starter } }),
      );
    setPath("../outside.json");
    expect(inspect().status).toBe("failed");
    writeFileSync(join(pack, "actual.json"), JSON.stringify({ schemaVersion: 1, state: [] }));
    symlinkSync(join(pack, "actual.json"), join(pack, "starter.json"));
    setPath("starter.json");
    expect(inspect().status).toBe("failed");
    setPath("actual.json");
    writeFileSync(join(pack, "actual.json"), " ".repeat(1_048_577));
    expect(inspect().status).toBe("failed");
  });
  it("validates metadata, declaration and entry path without executing behavior", () => {
    const { root, pack, inspect } = fixture();
    expect(inspect()).toMatchObject({
      status: "success",
      package: { name: "@example/climate-pack", lifecycle: "active" },
      declaration: { manifest: { id: "climate-control" } },
      modulePath: realpathSync(join(pack, "climate.ts")),
      diagnostics: [],
    });
    expect(
      inspectInstalledToolPackage({ repositoryRoot: root, packageName: "@example/missing" }).status,
    ).toBe("failed");
  });
  it.each(["../outside", "https://example.test/tool", "@example/climate-pack@latest"])(
    "rejects non-name selector %s",
    (packageName) => {
      const { root } = fixture();
      expect(inspectInstalledToolPackage({ repositoryRoot: root, packageName }).status).toBe("failed");
    },
  );
  it("warns on deprecation and rejects revoked metadata", () => {
    const { pack, metadata, inspect } = fixture();
    metadata.firedrill.lifecycle = "deprecated";
    writeFileSync(join(pack, "package.json"), JSON.stringify(metadata));
    expect(inspect()).toMatchObject({
      status: "success",
      diagnostics: [{ severity: "warning", code: "FD1403" }],
    });
    metadata.firedrill.lifecycle = "revoked";
    writeFileSync(join(pack, "package.json"), JSON.stringify(metadata));
    expect(inspect()).toMatchObject({ status: "failed", diagnostics: [{ code: "FD1403" }] });
  });
  it.each(["version", "engine", "module", "schema"])("rejects incompatible %s", (field) => {
    const { pack, inspect } = fixture();
    const file = join(pack, "climate.tool.json");
    const declaration = JSON.parse(readFileSync(file, "utf8"));
    if (field === "version") declaration.manifest.version = "4.0.0";
    if (field === "engine") declaration.manifest.engine = ">=99.0.0";
    if (field === "module") declaration.module = "../../outside.ts";
    if (field === "schema") declaration.manifest.operations = "invalid";
    writeFileSync(file, JSON.stringify(declaration));
    expect(inspect().status).toBe("failed");
  });
  it("rejects entry modules that escape through symlinks", () => {
    const { root, pack, inspect } = fixture();
    writeFileSync(join(root, "outside.ts"), "export default {};");
    rmSync(join(pack, "climate.ts"));
    symlinkSync(join(root, "outside.ts"), join(pack, "climate.ts"));
    expect(inspect().status).toBe("failed");
  });
  it("returns diagnostics for invalid or excessive YAML aliases", () => {
    const { pack, metadata, inspect } = fixture();
    metadata.firedrill.tool = "invalid.tool.yaml";
    writeFileSync(join(pack, "package.json"), JSON.stringify(metadata));
    writeFileSync(join(pack, "invalid.tool.yaml"), "schemaVersion: 1\nmodule: *missing\n");
    expect(inspect()).toMatchObject({ status: "failed", diagnostics: [{ code: "FD1101" }] });
  });
});
