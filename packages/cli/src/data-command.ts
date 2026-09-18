import { resolve } from "node:path";
import {
  FiredrillProjectError,
  loadDataImportPlan,
  loadDataImportPreview,
  previewDataImport,
  saveDataImport,
  storeDataImportPreview,
} from "@firedrill-run/sdk";
import type { CliIo } from "./program.js";

const HELP = `Import selected data as a reusable scenario

Usage:
  firedrill data preview <import-plan.json> --allow-read [--allow-origin <origin>] [--root <path>] [--json]
  firedrill data save <preview.json> --expect <preview-hash> --confirm save-reviewed-data [--root <path>] [--json]

Preview reads only the explicitly selected JSON file or read-only HTTP endpoint.
HTTP imports require its exact --allow-origin. Credentials come only from the
environment names declared in the plan; redirects and production writes are not supported.
Select fields and optional record ids; redact personal fields before saving.
Preview never changes world source or running state. Only a redacted preview is
saved under .firedrill/imports/. Review its complete contents before data save.
Save creates a new <id>.scenario.json in your source tree; never overwrites.
Keep the import plan free of secrets. Do not commit .firedrill/.
Guide: docs/data-import.md in the Firedrill source or installed SDK documentation.
`;

export async function executeDataCommand(args: readonly string[], io: CliIo): Promise<number> {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    io.stdout.write(HELP);
    return 0;
  }
  const json = args.includes("--json");
  try {
    const command = args[0];
    if (command !== "preview" && command !== "save")
      throw new Error("Use data preview or data save. See firedrill data --help.");
    const values = new Map<string, string>();
    let file: string | undefined;
    let consent = false;
    for (let i = 1; i < args.length; i++) {
      const arg = args[i] as string;
      if (arg === "--json") continue;
      if (arg === "--allow-read") {
        if (consent) throw new Error("--allow-read must not be repeated.");
        consent = true;
        continue;
      }
      if (["--root", "--allow-origin", "--expect", "--confirm"].includes(arg)) {
        const value = args[++i];
        if (!value || value.startsWith("-") || values.has(arg))
          throw new Error(`${arg} needs one value and must not be repeated.`);
        values.set(arg, value);
      } else if (arg.startsWith("-") || file !== undefined)
        throw new Error(`Unexpected argument ${arg}. See firedrill data --help.`);
      else file = arg;
    }
    if (!file) throw new Error("Select a plan or preview file. See firedrill data --help.");
    const root = resolve(io.cwd, values.get("--root") ?? ".");
    if (command === "preview") {
      if (!consent || values.has("--expect") || values.has("--confirm"))
        throw new Error("Preview requires --allow-read; --expect and --confirm belong to data save.");
      const plan = loadDataImportPlan(root, file);
      const preview = await previewDataImport({
        root,
        plan,
        consent: "read-selected-source",
        ...(values.has("--allow-origin") ? { allowedOrigin: values.get("--allow-origin") as string } : {}),
        ...(io.environment ? { environment: io.environment } : {}),
        ...(io.signal ? { signal: io.signal } : {}),
      });
      const previewPath = storeDataImportPreview(root, preview);
      if (json)
        io.stdout.write(
          `${JSON.stringify({ command: "data preview", status: "review_required", previewPath, ...preview })}\n`,
        );
      else
        io.stdout.write(
          `Review ${preview.recordCount} records (${preview.redactedFields} fields redacted).\nPreview: ${previewPath}\nSource and runtime are unchanged. Review the file, then save exactly these bytes:\nfiredrill data save ${previewPath} --expect ${preview.previewHash} --confirm save-reviewed-data\n`,
        );
    } else {
      if (
        consent ||
        values.has("--allow-origin") ||
        !values.has("--expect") ||
        values.get("--confirm") !== "save-reviewed-data"
      )
        throw new Error(
          "Save requires --expect <preview-hash> --confirm save-reviewed-data. It never reads a provider.",
        );
      const saved = await saveDataImport({
        root,
        preview: loadDataImportPreview(root, file),
        expectedPreviewHash: values.get("--expect") as string,
        confirm: "save-reviewed-data",
      });
      if (json) io.stdout.write(`${JSON.stringify({ command: "data save", status: "saved", ...saved })}\n`);
      else
        io.stdout.write(
          `Saved ${saved.recordCount} records to ${saved.path}.\nThe running world is unchanged. Start with: firedrill serve --scenario ${saved.id}\n`,
        );
    }
    return 0;
  } catch (error) {
    const code = error instanceof FiredrillProjectError ? error.code : "framework.DATA_IMPORT_INVALID";
    const message =
      error instanceof FiredrillProjectError ||
      error instanceof SyntaxError ||
      (error instanceof Error && !("code" in error))
        ? error.message
        : "The selected file could not be read. Check the path and permissions.";
    if (json)
      io.stdout.write(
        `${JSON.stringify({ command: "data", status: "failed", error: { code, message, retryable: false } })}\n`,
      );
    else io.stderr.write(`${message}\n`);
    return 2;
  }
}
