import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const workflowPath = resolve(import.meta.dirname, "..", ".github", "workflows", "publish.yml");
const workflow = readFileSync(workflowPath, "utf8");
const violations: string[] = [];

const required = [
  "release:\n    types: [published]",
  "if: github.repository == 'firedrill-tools/firedrill'",
  `ref: \${{ github.event.release.tag_name }}`,
  "persist-credentials: false",
  "git merge-base --is-ancestor",
  "environment:\n      name: npm",
  "registry-url: https://registry.npmjs.org",
  "package-manager-cache: false",
  "sha256sum --check SHA256SUMS",
  'npm publish "$archive" --access public --tag "$DIST_TAG" --ignore-scripts',
] as const;

for (const fragment of required) {
  if (!workflow.includes(fragment)) violations.push(`publish.yml is missing: ${fragment}`);
}

for (const forbidden of [
  "workflow_dispatch:",
  "pull_request_target:",
  "workflow_run:",
  "NODE_AUTH_TOKEN",
  "NPM_TOKEN",
  "secrets.",
]) {
  if (workflow.includes(forbidden)) violations.push(`publish.yml must not contain: ${forbidden}`);
}

const oidcGrants = workflow.match(/^\s+id-token:\s*write\s*$/gm) ?? [];
if (oidcGrants.length !== 1) {
  violations.push(`publish.yml must grant id-token: write exactly once; found ${oidcGrants.length}`);
}

const publishJob = workflow.split("\n  publish:\n")[1];
if (!publishJob) {
  violations.push("publish.yml has no publish job");
} else if (publishJob.includes("actions/checkout@")) {
  violations.push("the OIDC publish job must not check out or execute repository source");
}

for (const line of workflow.split("\n")) {
  const action = line.match(/^\s*-?\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/)?.[1];
  if (action && !/@[0-9a-f]{40}$/.test(action)) {
    violations.push(`GitHub Action is not pinned to a full commit: ${action}`);
  }
}

if (violations.length > 0) {
  process.stderr.write(`${violations.sort().join("\n")}\n`);
  process.exit(1);
}

process.stdout.write("npm trusted-publishing workflow policy passed\n");
