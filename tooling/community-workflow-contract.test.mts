import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  resolve(import.meta.dirname, "../.github/workflows/community-tools-sync.yml"),
  "utf8",
);

describe("community Tool workflow contract", () => {
  it("accepts only exact public firedrill-tools release dispatches", () => {
    expect(workflow).toContain("DISPATCH_SOURCE_REPOSITORY");
    expect(workflow).toContain('source_repository="firedrill-tools/firedrill-tools"');
    expect(workflow).toContain('contract_version="1"');
    expect(workflow).toContain('artifact_name" == "firedrill-tools-$revision"');
    expect(workflow).toContain("repositories: firedrill-tools");
    expect(workflow).toContain('expected_name="firedrill-tools-$REVISION"');
    expect(workflow).not.toContain("repositories: firedrill-community-tools");
  });
});
