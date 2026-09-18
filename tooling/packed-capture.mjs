import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runDrills, verifyReport } from "@firedrill-run/sdk";

// Executed after copying into the clean consumer: no workspace implementation imports.
const root = process.argv[2];
assert.ok(root);
writeFileSync(join(root, "details.json"), JSON.stringify({ purpose: "packed attachment proof" }));
const capture = { logs: "always", files: "retain-on-failure" };
const hooks = {
  attemptStarted({ capture }) {
    capture.log("Starting the unchanged command target");
    capture.file({ path: "details.json", mediaType: "application/json" });
  },
};

const passing = await runDrills({ root, drill: "set-record", capture, hooks });
assert.equal(passing.verdict, "passed");
const passedAttempt = passing.drills[0].trials[0].attempts[0];
assert.deepEqual(
  passedAttempt.result.capture.attachments.map((item) => item.kind),
  ["log"],
);
assert.equal(passedAttempt.result.capture.discarded.files, 1);
assert.deepEqual(passedAttempt.result.capture.errors, []);
verifyReport({ report: passedAttempt.report.directory });

const drillPath = join(root, "firedrill", "drills", "set-record.drill.yaml");
const original = readFileSync(drillPath, "utf8");
const failingSource = original.replace(
  "operator: equals\n      value: 7",
  "operator: equals\n      value: 8",
);
assert.notEqual(failingSource, original);
writeFileSync(drillPath, failingSource);
try {
  const failed = await runDrills({ root, drill: "set-record", capture, hooks });
  assert.equal(failed.verdict, "failed");
  const attempt = failed.drills[0].trials[0].attempts[0];
  assert.deepEqual(attempt.result.capture.attachments.map((item) => item.kind).sort(), ["file", "log"]);
  assert.deepEqual(attempt.result.capture.errors, []);
  assert.equal(attempt.result.capture.discarded.files, 0);
  const html = readFileSync(join(attempt.report.directory, "index.html"), "utf8");
  assert.ok(html.includes("Starting the unchanged command target"));
  assert.ok(html.includes('id="attachments"'));
  const verified = verifyReport({ report: attempt.report.directory });
  assert.ok(verified);
  const manifest = JSON.parse(readFileSync(join(attempt.report.directory, "manifest.json"), "utf8"));
  assert.equal(manifest.presentationVersion, 3);
  assert.equal(
    readFileSync(join(root, "details.json"), "utf8"),
    JSON.stringify({ purpose: "packed attachment proof" }),
  );
} finally {
  writeFileSync(drillPath, original);
}
process.stdout.write(
  "Packed SDK capture: passing discard, failed-assertion retention, logs, report verification, unchanged caller files\n",
);
