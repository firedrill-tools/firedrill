import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const cli = resolve(root, "../../packages/cli/dist/bin.js");

function invoke(arguments_) {
  const result = spawnSync(process.execPath, [cli, ...arguments_, "--root", root], {
    cwd: root,
    encoding: "utf8",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(
      `firedrill ${arguments_.join(" ")} failed\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    );
  }
  return result.stdout ?? "";
}

const humanInspection = invoke(["tool", "inspect", "github-issues"]);
if (
  !humanInspection.includes("Compatibility octokit-rest-21: @octokit/rest@21.1.1") ||
  !humanInspection.includes("rest.issues.createComment → create-comment") ||
  !humanInspection.includes("Limitation — Only the four listed Issues and issue-comment routes")
) {
  throw new Error("human Tool inspection omitted the bounded compatibility profile");
}

const inspection = JSON.parse(invoke(["tool", "inspect", "github-issues", "--json"]));
const profile = inspection.tool?.manifest?.compatibility?.[0];
if (
  profile?.client?.name !== "@octokit/rest" ||
  profile?.client?.version !== "21.1.1" ||
  profile?.routes?.length !== 4 ||
  profile?.limitations?.length !== 3
) {
  throw new Error("machine-readable Tool inspection omitted exact compatibility bounds");
}

const conformance = JSON.parse(invoke(["tool", "test", "github-issues", "--json"]));
if (conformance.status !== "passed" || conformance.deterministic !== true) {
  throw new Error(`Tool conformance failed: ${JSON.stringify(conformance.violations)}`);
}
const reports = conformance.runs.flatMap((run) =>
  run.drills.flatMap((drill) => drill.trials.map((trial) => trial.htmlReport)),
);
if (reports.length !== 4) throw new Error(`expected four conformance reports, received ${reports.length}`);

for (const htmlPath of reports) {
  const reportDirectory = resolve(htmlPath, "..");
  const manifest = JSON.parse(readFileSync(resolve(reportDirectory, "manifest.json"), "utf8"));
  const report = JSON.parse(readFileSync(resolve(reportDirectory, "report.json"), "utf8"));
  const html = readFileSync(htmlPath, "utf8");
  if (
    manifest.tools?.[0]?.compatibility?.[0]?.id !== "octokit-rest-21" ||
    report.tools?.[0]?.compatibility?.[0]?.client?.version !== "21.1.1" ||
    !html.includes("@octokit/rest@21.1.1") ||
    !html.includes("Known limitations")
  ) {
    throw new Error(`report ${reportDirectory} omitted compatibility and fidelity evidence`);
  }
}

process.stdout.write(
  "GitHub Issues Tool: official client flow, faults, deterministic conformance, and report fidelity verified.\n",
);
