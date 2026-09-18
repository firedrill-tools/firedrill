import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runCli } from "../src/index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function consumer(module?: string) {
  const root = mkdtempSync(join(tmpdir(), "firedrill-cloud-cli-test-"));
  roots.push(root);
  if (module !== undefined) {
    const directory = join(root, "node_modules", "@firedrill-run", "cloud");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({ name: "@firedrill-run/cloud", type: "module", exports: { "./cli": "./cloud.mjs" } }),
    );
    writeFileSync(join(directory, "cloud.mjs"), module);
  }
  let output = "";
  let errors = "";
  const io = {
    cwd: root,
    stdout: {
      write(value: string) {
        output += value;
      },
    },
    stderr: {
      write(value: string) {
        errors += value;
      },
    },
    environment: { CI: "true" },
  };
  return { root, io, output: () => output, errors: () => errors };
}

it("does not discover or load a destination client during a local command", async () => {
  const context = consumer("throw new Error('extension must not load for local help');");
  expect(await runCli(["validate", "--help"], context.io)).toBe(0);
  expect(context.output()).toContain("validate");
  expect(context.errors()).toBe("");
  expect(readdirSync(context.root)).toEqual(["node_modules"]);
});

it("explains the missing optional package without installation, authentication or writes", async () => {
  const context = consumer();
  expect(await runCli(["cloud", "publish", "--json"], context.io)).toBe(2);
  expect(JSON.parse(context.output()).code).toBe("FD_CLOUD_EXTENSION_UNAVAILABLE");
  expect(readdirSync(context.root)).toEqual([]);
});

it("dispatches the exact explicit cloud arguments to the consumer-installed fixed extension", async () => {
  const context = consumer(
    "export async function runCloudCli(args, io) { io.stdout.write(JSON.stringify({args, cwd: io.cwd, ci: io.environment.CI})); return 7; }",
  );
  const args = ["publish", "--project", "prj_exact", "--root", "world", "--json"];
  expect(await runCli(["cloud", ...args], context.io)).toBe(7);
  expect(JSON.parse(context.output())).toEqual({ args, cwd: context.root, ci: "true" });
});

it("reports unresolved execution without leaking a thrown transport error or pretending nothing happened", async () => {
  const context = consumer(
    "export async function runCloudCli() { throw new Error('SENSITIVE_TRANSPORT_VALUE'); }",
  );
  expect(await runCli(["cloud", "publish", "--json"], context.io)).toBe(1);
  expect(JSON.parse(context.output()).status).toBe("unknown");
  expect(context.output()).not.toContain("SENSITIVE_TRANSPORT_VALUE");
});

it("passes terminal capability independently of allocating a prompt reader", async () => {
  const context = consumer(
    "export async function runCloudCli(args, io) { io.stdout.write(JSON.stringify({interactive: io.interactive, prompt: typeof io.ask})); return 0; }",
  );
  expect(await runCli(["cloud", "login"], { ...context.io, interactive: true, environment: {} })).toBe(0);
  expect(JSON.parse(context.output())).toEqual({ interactive: true, prompt: "undefined" });
});
