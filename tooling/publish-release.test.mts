import { describe, expect, it } from "vitest";
import { topologicalPublishLayers } from "./publish-release.mts";

function artifact(name: string, dependencies: readonly string[] = []) {
  return {
    name,
    manifest: { dependencies: Object.fromEntries(dependencies.map((dependency) => [dependency, "1.0.0"])) },
  };
}

describe("release publication order", () => {
  it("publishes dependencies before consumers with stable ordering", () => {
    expect(
      topologicalPublishLayers([
        artifact("@firedrill-run/cli", ["@firedrill-run/sdk"]),
        artifact("@firedrill-run/contracts"),
        artifact("@firedrill-run/sdk", ["@firedrill-run/contracts"]),
        artifact("@firedrill-run/browser-tests"),
      ]),
    ).toEqual([
      ["@firedrill-run/browser-tests", "@firedrill-run/contracts"],
      ["@firedrill-run/sdk"],
      ["@firedrill-run/cli"],
    ]);
  });

  it("rejects a dependency cycle", () => {
    expect(() =>
      topologicalPublishLayers([
        artifact("@firedrill-run/a", ["@firedrill-run/b"]),
        artifact("@firedrill-run/b", ["@firedrill-run/a"]),
      ]),
    ).toThrow("dependency cycle");
  });
});
