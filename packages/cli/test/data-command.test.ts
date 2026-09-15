import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runCli } from "../src/index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "firedrill-data-cli-"));
  roots.push(root);
  mkdirSync(join(root, "world"));
  const json = (path: string, value: unknown) => writeFileSync(join(root, path), JSON.stringify(value));
  json("firedrill.json", { schemaVersion: 1, sourceRoot: "world", world: "world.json" });
  json("world/world.json", { schemaVersion: 1, id: "import-example" });
  json("world/service.tool.json", {
    schemaVersion: 1,
    module: "./service.js",
    manifest: {
      schemaVersion: 1,
      id: "files",
      version: "1.0.0",
      engine: ">=0.1.0 <0.2.0",
      capabilities: ["state.read"],
      state: [
        {
          namespace: "entries",
          schema: {
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"],
            additionalProperties: false,
          },
        },
      ],
      operations: [
        {
          id: "list",
          inputSchema: { type: "object" },
          outputSchema: { type: "array" },
          fidelity: "stateful",
          idempotency: "none",
        },
      ],
    },
  });
  writeFileSync(
    join(root, "world/service.js"),
    'export default {operations:{list(_input,context){return context.state.list("entries");}}};',
  );
  json("records.json", [{ id: "one", name: "document" }]);
  json("import-plan.json", {
    schemaVersion: 1,
    id: "documents",
    source: { kind: "json", path: "records.json" },
    packageId: "files",
    namespace: "entries",
    idPointer: "/id",
    fields: { name: "/name" },
  });
  return root;
}
async function command(root: string, args: string[]) {
  let output = "";
  let error = "";
  const code = await runCli(args, {
    cwd: root,
    stdout: {
      write: (text) => {
        output += text;
      },
    },
    stderr: {
      write: (text) => {
        error += text;
      },
    },
  });
  return { code, output, error };
}
it("executes preview, exact review and validated source save through the public CLI", async () => {
  const root = fixture();
  const rejected = await command(root, ["data", "preview", "import-plan.json", "--json"]);
  expect(rejected.code).toBe(2);
  expect(existsSync(join(root, ".firedrill/imports"))).toBe(false);
  const result = await command(root, ["data", "preview", "import-plan.json", "--allow-read", "--json"]);
  expect(result.code, result.error || result.output).toBe(0);
  const preview = JSON.parse(result.output);
  expect(preview).toMatchObject({ status: "review_required", recordCount: 1, runtimeChanged: false });
  expect(existsSync(join(root, "world/scenarios"))).toBe(false);
  const saved = await command(root, [
    "data",
    "save",
    preview.previewPath,
    "--expect",
    preview.previewHash,
    "--confirm",
    "save-reviewed-data",
    "--json",
  ]);
  expect(saved.code, saved.error || saved.output).toBe(0);
  expect(JSON.parse(saved.output)).toMatchObject({
    status: "saved",
    path: "world/scenarios/documents.scenario.json",
  });
  expect(
    JSON.parse(readFileSync(join(root, "world/scenarios/documents.scenario.json"), "utf8")),
  ).toMatchObject({ state: [{ rowId: "one", value: { name: "document" } }] });
  expect((await command(root, ["validate", "--json"])).code).toBe(0);
});
it("help never imports or writes, and syntax errors never echo source content", async () => {
  const root = fixture();
  const before = readdirSync(root);
  for (const args of [
    ["data", "--help"],
    ["data", "save", "--help"],
    ["data", "preview", "missing", "--help"],
  ])
    expect((await command(root, args)).code).toBe(0);
  expect(readdirSync(root)).toEqual(before);
  writeFileSync(join(root, "broken.json"), "private-secret-value is not JSON");
  const result = await command(root, ["data", "preview", "broken.json", "--allow-read", "--json"]);
  expect(result.code).toBe(2);
  expect(result.output).not.toContain("private-secret-value");
});
