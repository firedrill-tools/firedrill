import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const violations: string[] = [];
const forbidden = [
  "atlas",
  "harbor-world",
  "calendar",
  "events.create",
  "inventory",
  "stock.reserve",
  "activity-log",
  "entries.list",
  "contacts.lookup",
  "typed-store",
  "records.break",
  "value.increment",
  "billing.refund",
  "support-desk",
  "ticketByOrder",
  "ticketIds",
  "ord_1001",
  "ord_1002",
  "source-control",
  "changes.submit",
  "pipeline-runner",
  "building-controls",
  "targets.set",
  "load-monitor",
  "sample-registry",
  "samples.record",
  "analysis-queue",
  "random-ledger",
  "draws.record",
  "atomic-counter",
  "counters.increment",
  "crash-probe",
  "effects.apply",
  "timer-source",
  "timer-consumer",
  "task.due",
];

for (const group of ["packages", "apps"]) {
  const groupDirectory = join(root, group);
  if (!existsSync(groupDirectory)) continue;
  for (const packageEntry of readdirSync(groupDirectory, { withFileTypes: true })) {
    if (!packageEntry.isDirectory()) continue;
    const packageDirectory = join(groupDirectory, packageEntry.name);
    const packageJson = JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8")) as {
      firedrill?: { layer?: string };
    };
    if (packageJson.firedrill?.layer === "tool-pack" || packageJson.firedrill?.layer === "example") continue;
    const sourceDirectory = join(packageDirectory, "src");
    if (!existsSync(sourceDirectory)) continue;
    const visit = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const file = join(directory, entry.name);
        if (entry.isDirectory()) visit(file);
        else if (/\.[cm]?[jt]sx?$/.test(entry.name)) {
          const contents = readFileSync(file, "utf8");
          for (const term of forbidden) {
            if (contents.toLowerCase().includes(term.toLowerCase())) {
              violations.push(`${relative(root, file)} contains reference-world term ${term}`);
            }
          }
        }
      }
    };
    visit(sourceDirectory);
  }
}

if (violations.length > 0) {
  process.stderr.write(`${violations.join("\n")}\n`);
  process.exit(1);
}

process.stdout.write("framework genericity scan passed\n");
