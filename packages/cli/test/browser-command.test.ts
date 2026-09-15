import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function invoke(root: string, args: string[], environment: Record<string, string> = {}) {
  let stdout = "";
  let stderr = "";
  const exitCode = await runCli(["browser", ...args], {
    cwd: root,
    environment,
    stdout: {
      write: (text) => {
        stdout += text;
      },
    },
    stderr: {
      write: (text) => {
        stderr += text;
      },
    },
  });
  return { exitCode, stdout, stderr };
}
function project() {
  const root = mkdtempSync(join(tmpdir(), "firedrill-browser-cli-"));
  roots.push(root);
  return root;
}

describe("optional browser CLI", () => {
  it("keeps help read-only and rejects model, command, and source ambiguity", async () => {
    const root = project();
    expect((await invoke(root, ["--help"])).stdout).toContain("Saved steps need no model key");
    for (const args of [
      ["anything"],
      ["run"],
      ["run", "test.json", "--agent"],
      ["run", "test.json", "--url", "http://localhost"],
      ["run", "--url", "http://localhost", "--task", "click"],
      ["verify", "report", "--agent"],
      ["run", "test.json", "--model", "sonnet"],
    ]) {
      const result = await invoke(root, [...args, "--json"]);
      expect(result.exitCode).toBe(2);
      expect(JSON.parse(result.stdout).code).toBe("browser.COMMAND_INVALID");
    }
  });

  it("runs real saved steps, saves source, checks failure, and verifies the report through the CLI", async () => {
    const root = project();
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end(
        "<button onclick=\"document.querySelector('output').textContent='Done'\">Submit</button><output>Ready</output>",
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (typeof address !== "object" || address === null) throw new Error("No test listener");
      const definition = {
        schemaVersion: 1,
        id: "simple-action",
        startUrl: `http://127.0.0.1:${address.port}`,
        steps: [{ action: "click", selector: { by: "role", role: "button", name: "Submit" } }],
        assertions: [
          { id: "saved", kind: "text", selector: { by: "css", value: "output" }, expected: "Done" },
        ],
      };
      writeFileSync(join(root, "test.browser.json"), JSON.stringify(definition));
      const passed = await invoke(root, ["run", "test.browser.json", "--save", "reusable-action", "--json"]);
      expect(passed.exitCode, passed.stdout + passed.stderr).toBe(0);
      const result = JSON.parse(passed.stdout);
      expect(result.status).toBe("passed");
      expect(result.worldVerified).toBe(false);
      expect(readFileSync(result.reportPath, "utf8")).toContain("Done");
      expect(JSON.parse(readFileSync(result.savedPath, "utf8")).steps).toHaveLength(1);
      const verified = await invoke(root, ["verify", result.reportDirectory, "--json"]);
      expect(verified.exitCode, verified.stdout + verified.stderr).toBe(0);
      const assertion = definition.assertions[0];
      if (!assertion) throw new Error("Missing test assertion");
      assertion.expected = "Wrong expectation";
      writeFileSync(join(root, "test.browser.json"), JSON.stringify(definition));
      const failed = await invoke(root, ["run", "test.browser.json", "--json"]);
      expect(failed.exitCode, failed.stdout).toBe(1);
      expect(JSON.parse(failed.stdout).assertions[0].passed).toBe(false);
      writeFileSync(result.reportPath, "changed");
      expect((await invoke(root, ["verify", result.reportDirectory, "--json"])).exitCode).toBe(2);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30000);
});
