import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleBrowserTestReport, verifyBrowserTestReport } from "@firedrill/browser-tests";

// Copy this file into the tarball-only consumer before executing it. No workspace imports.
const consumer = resolve(process.cwd());
const minimalConsumer = resolve(process.argv[2] ?? "");
assert.ok(process.argv[2], "Pass the separately installed consumer without optional browser dependencies");
const installedBrowser = fileURLToPath(import.meta.resolve("@firedrill/browser-tests"));
assert.ok(
  installedBrowser.startsWith(`${consumer}${sep}node_modules${sep}`),
  "The browser proof must resolve an installed tarball, not workspace source",
);
const environment = Object.fromEntries(
  [
    "PATH",
    "HOME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "XDG_CACHE_HOME",
    "PLAYWRIGHT_BROWSERS_PATH",
    "SystemRoot",
    "WINDIR",
  ].flatMap((name) => (process.env[name] === undefined ? [] : [[name, process.env[name]]])),
);
environment.CI = "1";
environment.DO_NOT_TRACK = "1";
assert.equal(environment.ANTHROPIC_API_KEY, undefined);

function run(command, args, cwd = consumer) {
  return new Promise((resolve_, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let failure;
    const timer = setTimeout(() => {
      failure = new Error("Packed browser child exceeded its 45-second deadline");
      child.kill("SIGKILL");
    }, 45000);
    const collect = (stream) => (chunk) => {
      if (stream === "stdout") stdout += chunk;
      else stderr += chunk;
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 1024 * 1024) {
        failure = new Error("Packed browser child exceeded its 1 MiB output budget");
        stdout = "";
        stderr = "";
        child.kill("SIGKILL");
      }
    };
    child.stdout.on("data", collect("stdout"));
    child.stderr.on("data", collect("stderr"));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (signal) reject(new Error(`Packed browser child exited on ${signal}`));
      else resolve_({ code, stdout, stderr });
    });
  });
}

const cli = join(consumer, "node_modules", ".bin", "firedrill");
const minimalCli = join(minimalConsumer, "node_modules", ".bin", "firedrill");
const absent = await run(minimalCli, ["browser", "verify", "missing-report", "--json"], minimalConsumer);
assert.equal(absent.code, 2, absent.stderr);
assert.match(JSON.parse(absent.stdout).message, /Install the optional browser package/);
assert.match(JSON.parse(absent.stdout).message, /@firedrill\/browser-tests/);
const help = await run(minimalCli, ["--help"], minimalConsumer);
assert.equal(help.code, 0, help.stderr);
assert.match(help.stdout, /firedrill/);
const validation = await run(minimalCli, ["validate", "--json"], minimalConsumer);
assert.equal(validation.code, 0, validation.stderr);
assert.equal(JSON.parse(validation.stdout).status, "success");

const root = mkdtempSync(join(consumer, "packed-browser-"));
const sourceDirectory = join(root, "firedrill", "browser-tests");
mkdirSync(sourceDirectory, { recursive: true });
let receivedClicks = 0;
const html = `<!doctype html><html lang="en"><title>Packed browser example</title>
<button type="button">Increment</button><output role="status">0</output>
<script>document.querySelector('button').onclick = async () => {
  await fetch('/clicked', { method: 'POST' });
  document.querySelector('output').textContent = '1';
};</script></html>`;
const server = createServer((request, response) => {
  if (request.method === "POST" && request.url === "/clicked") {
    receivedClicks++;
    response.writeHead(204);
    response.end();
  } else {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(html);
  }
});
await new Promise((resolve_, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve_);
});
const address = server.address();
assert.ok(address && typeof address !== "string");

async function execute(path, extra = []) {
  const executed = await run(cli, [
    "browser",
    "run",
    relative(root, path),
    "--root",
    root,
    "--timeout-ms",
    "15000",
    "--step-timeout-ms",
    "500",
    "--json",
    ...extra,
  ]);
  assert.ok(executed.stdout, executed.stderr);
  return { ...executed, result: JSON.parse(executed.stdout) };
}

try {
  const definition = {
    schemaVersion: 1,
    id: "packed-click",
    title: "Increment through the real browser",
    startUrl: `http://127.0.0.1:${address.port}`,
    steps: [{ action: "click", selector: { by: "role", role: "button", name: "Increment" } }],
    assertions: [
      { id: "incremented", kind: "text", selector: { by: "css", value: "output" }, expected: "1" },
    ],
  };
  const path = join(sourceDirectory, "packed-click.browser.json");
  const original = `${JSON.stringify(definition, null, 2)}\n`;
  writeFileSync(path, original);
  const passing = await execute(path, ["--save", "recorded-click"]);
  assert.equal(passing.code, 0, passing.stderr || passing.stdout);
  assert.equal(passing.result.status, "passed");
  assert.equal(passing.result.worldVerified, false);
  assert.equal(passing.result.assertions[0]?.actual, "1");
  assert.equal(receivedClicks, 1, "The external CLI must drive a real page interaction");
  assert.ok(passing.result.savedPath, "The packed CLI must save a reusable local definition");
  assert.equal(readFileSync(path, "utf8"), original, "Running must not modify caller-authored source");
  assert.equal(verifyBrowserTestReport(passing.result.reportDirectory).status, "passed");
  const verified = await run(cli, ["browser", "verify", passing.result.reportDirectory, "--json"]);
  assert.equal(verified.code, 0, verified.stderr);
  assert.equal(JSON.parse(verified.stdout).runId, passing.result.runId);

  const replay = await execute(passing.result.savedPath);
  assert.equal(replay.code, 0, replay.stderr || replay.stdout);
  assert.equal(replay.result.status, "passed");
  assert.equal(receivedClicks, 2, "Saved steps must drive a second fresh browser without a model");
  assert.notEqual(replay.result.runId, passing.result.runId);

  const failingPath = join(sourceDirectory, "wrong-expectation.browser.json");
  writeFileSync(
    failingPath,
    JSON.stringify({
      ...definition,
      id: "wrong-expectation",
      assertions: [{ ...definition.assertions[0], expected: "2" }],
    }),
  );
  const failing = await execute(failingPath);
  assert.equal(failing.code, 1, failing.stderr || failing.stdout);
  assert.equal(failing.result.status, "failed");
  assert.equal(failing.result.assertions[0]?.expected, "2");
  assert.equal(failing.result.assertions[0]?.actual, "1");
  assert.equal(failing.result.assertions[0]?.passed, false);
  assert.equal(receivedClicks, 3);
  assert.equal(verifyBrowserTestReport(failing.result.reportDirectory).status, "failed");
  assert.ok(failing.result.artifacts.some((artifact) => artifact.path === "screenshot.png"));

  const bundle = await bundleBrowserTestReport(failing.result.reportDirectory);
  const archive = join(root, bundle.filename);
  writeFileSync(archive, bundle.bytes);
  const unpacked = join(root, "unpacked-report");
  mkdirSync(unpacked);
  const extraction = await run("tar", ["-xzf", archive, "-C", unpacked]);
  assert.equal(extraction.code, 0, extraction.stderr);
  const copiedDirectory = join(unpacked, failing.result.runId);
  const copied = verifyBrowserTestReport(copiedDirectory);
  assert.equal(copied.runId, failing.result.runId);
  assert.equal(copied.status, "failed");
  assert.ok(readFileSync(join(copiedDirectory, "screenshot.png")).byteLength > 0);
  const reportHtml = readFileSync(join(copiedDirectory, "index.html"), "utf8");
  assert.match(reportHtml, /Expected/);
  assert.match(reportHtml, /Actual/);
  assert.doesNotMatch(reportHtml, /<script\b[^>]*\bsrc\s*=/i);
  writeFileSync(join(copiedDirectory, "index.html"), `${reportHtml}\nchanged`);
  assert.throws(() => verifyBrowserTestReport(copiedDirectory), /manifest/);
  process.stdout.write(
    "Packed optional browser: missing-package guidance, ordinary CLI, real click, pass/fail exits, model-free saved replay, verified portable report and screenshot\n",
  );
} finally {
  server.closeAllConnections();
  await new Promise((resolve_) => server.close(resolve_));
  rmSync(root, { recursive: true, force: true });
}
