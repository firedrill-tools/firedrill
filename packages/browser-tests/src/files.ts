import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  type BrowserTestDefinitionInput,
  BrowserTestDefinitionSchema,
  BrowserTestError,
} from "./contracts.js";

export function inside(root: string, path: string): string {
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new BrowserTestError(
      "browser.PATH_OUTSIDE_PROJECT",
      "Choose a file or directory inside the project.",
    );
  let cursor = root;
  for (const part of rel.split(sep)) {
    cursor = resolve(cursor, part);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink())
      throw new BrowserTestError(
        "browser.SYMLINK_FORBIDDEN",
        "Browser source and reports cannot use symbolic links.",
      );
  }
  return target;
}
export function digest(body: Buffer | string): string {
  return createHash("sha256").update(body).digest("hex");
}
export function writeNew(path: string, body: string | Buffer): void {
  writeFileSync(path, body, { flag: "wx", mode: 0o600 });
}
export function loadBrowserTest(options: { readonly root?: string; readonly path: string }) {
  const root = realpathSync(options.root ?? process.cwd());
  const path = inside(root, options.path);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > 256 * 1024)
    throw new BrowserTestError(
      "browser.INVALID_DEFINITION",
      "Browser test source must be a JSON file smaller than 256 KiB.",
    );
  return BrowserTestDefinitionSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}
export function saveBrowserTest(options: {
  readonly root?: string;
  readonly path?: string;
  readonly definition: BrowserTestDefinitionInput;
}): string {
  const definition = BrowserTestDefinitionSchema.parse(options.definition);
  const root = realpathSync(options.root ?? process.cwd());
  const path = inside(root, options.path ?? `firedrill/browser-tests/${definition.id}.browser.json`);
  const segments = relative(root, path).split(sep);
  if (segments.some((part) => part.startsWith(".") || part === "node_modules") || !path.endsWith(".json"))
    throw new BrowserTestError(
      "browser.INVALID_DEFINITION_PATH",
      "Save a browser definition as a non-hidden project JSON file.",
    );
  mkdirSync(dirname(path), { recursive: true });
  writeNew(path, `${JSON.stringify(definition, null, 2)}\n`);
  return path;
}
