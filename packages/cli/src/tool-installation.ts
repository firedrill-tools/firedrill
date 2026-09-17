import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { inspectInstalledToolPackage } from "@firedrill-tools/compiler";
import { NodePackageNameSchema, SemverSchema } from "@firedrill-tools/contracts";
import { list } from "tar";

const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 64 * 1024 * 1024;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 4_096;

export class FiredrillToolInstallationError extends Error {
  readonly code = "framework.TOOL_INSTALL_FAILED";
  constructor(
    message: string,
    readonly suggestion: string,
  ) {
    super(message);
    this.name = "FiredrillToolInstallationError";
  }
}

export interface InstallToolSourceOptions {
  readonly root: string;
  readonly source: string;
  readonly signal?: AbortSignal;
}

export interface ToolInstallation {
  readonly packageName: string;
  readonly version: string;
  /** Safe selector; local paths outside the project are intentionally not retained. */
  readonly source: string;
  /** Exact registry version, content digest, or Git commit and package directory. */
  readonly resolvedSource: string;
  readonly integrity: string;
  readonly packageManager: "npm" | "pnpm";
  /** Source dependency to commit alongside package.json and the package-manager lock. */
  readonly archivePath?: string;
  readonly provenancePath?: string;
}

type Source =
  | { kind: "npm"; selector: string }
  | { kind: "local"; path: string; label: string }
  | { kind: "git"; url: string; ref: string; directory: string; label: string };

function fail(message: string, suggestion: string): never {
  throw new FiredrillToolInstallationError(message, suggestion);
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some(
    (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
}

function safeSegments(value: string): boolean {
  return (
    !isAbsolute(value) &&
    !value.includes("\\") &&
    !hasControlCharacters(value) &&
    !value.includes(":") &&
    value.split("/").every((part) => part !== ".." && part !== "." && part !== "")
  );
}

function localLabel(root: string, path: string): string {
  const part = relative(root, path).split(sep).join("/");
  return part && safeSegments(part) ? `./${part}` : "local-package";
}

function parseSource(root: string, input: string): Source {
  if (!input || input.length > 4_096 || hasControlCharacters(input))
    fail(
      "The Tool source is empty or contains unsupported characters.",
      "Use a package name, local path, or Git selector.",
    );
  if (input.startsWith(".") || isAbsolute(input) || input.startsWith("file:")) {
    const path = input.startsWith("file:")
      ? input.startsWith("file://")
        ? fileURLToPath(new URL(input))
        : resolve(root, input.slice(5))
      : resolve(root, input);
    return { kind: "local", path, label: localLabel(root, path) };
  }
  const npm = /^(?:npm:)?((?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)(?:@([a-zA-Z0-9.*^~+_-]+))?$/.exec(input);
  if (npm && NodePackageNameSchema.safeParse(npm[1]).success)
    return { kind: "npm", selector: `${npm[1]}${npm[2] ? `@${npm[2]}` : ""}` };

  const parts = input.split("::");
  if (parts.length > 2 || (parts[1] !== undefined && !safeSegments(parts[1])))
    fail(
      "The Git package directory is invalid.",
      "Use github:owner/repo#ref::path/to/package without parent traversal.",
    );
  const selector = parts[0] ?? "";
  const hash = selector.indexOf("#");
  let url = hash < 0 ? selector : selector.slice(0, hash);
  const ref = hash < 0 ? "HEAD" : selector.slice(hash + 1);
  if (!/^[A-Za-z0-9_][A-Za-z0-9._/-]*$/.test(ref) || ref.includes("..") || ref.endsWith(".lock"))
    fail("The Git ref is invalid.", "Use a branch, tag, or full commit hash after #.");
  if (url.startsWith("github:")) url = url.slice(7);
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(url)) url = `https://github.com/${url}.git`;
  if (url.startsWith("git+")) url = url.slice(4);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return fail(
      "The Tool source is not a package, local path, or supported Git URL.",
      "Use @owner/package@1.0.0, ./tool, or github:owner/repo#ref::package.",
    );
  }
  if (
    !["https:", "file:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.protocol === "file:" && !input.startsWith("git+file://"))
  )
    fail(
      "Git sources must use credential-free HTTPS or explicit local git+file URLs.",
      "Use your Git credential helper for private HTTPS repositories; never put tokens in the selector.",
    );
  if (parsed.protocol === "file:") {
    if (parsed.host && parsed.host !== "localhost")
      fail("Local Git URLs cannot name a remote host.", "Use git+file:///absolute/repository#ref.");
    assertNoLinks(fileURLToPath(parsed));
  }
  const directory = parts[1] ?? "";
  return {
    kind: "git",
    url: parsed.href,
    ref,
    directory,
    label: `${parsed.protocol === "file:" ? "local-git" : parsed.href}#${ref}${directory ? `::${directory}` : ""}`,
  };
}

function assertNoLinks(path: string, boundary = path): void {
  const absolute = resolve(path);
  const parent = dirname(absolute);
  if (parent !== absolute && absolute !== resolve(boundary)) assertNoLinks(parent, boundary);
  if (lstatSync(absolute).isSymbolicLink())
    fail(
      "Tool sources cannot follow symbolic links.",
      "Use a real package directory or archive, with contained regular files.",
    );
}

function checkTree(path: string, count = { value: 0, bytes: 0 }): void {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if ([".git", "node_modules"].includes(entry.name)) continue;
    if (++count.value > MAX_FILES)
      fail(
        "The Tool source contains too many files.",
        "Use a small standalone package directory with a files allowlist.",
      );
    if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory()))
      fail(
        "Tool package source contains a link or special file.",
        "Replace it with contained regular source files before installing.",
      );
    if (entry.isDirectory()) checkTree(join(path, entry.name), count);
    else {
      const size = lstatSync(join(path, entry.name)).size;
      count.bytes += size;
      if (size > MAX_FILE_BYTES || count.bytes > MAX_EXPANDED_BYTES)
        fail(
          "Local Tool source exceeds the per-file or total source size bound.",
          "Use a standalone source-only package smaller than 64 MiB with files no larger than 16 MiB.",
        );
    }
  }
}

/** Best-effort acquisition watchdog, not an OS filesystem quota. Never follows links. */
function temporarySizeExceeded(root: string): boolean {
  let bytes = 0;
  let entries = 0;
  const visit = (path: string): boolean => {
    if (++entries > 20_000) return true;
    let info: ReturnType<typeof lstatSync>;
    try {
      info = lstatSync(path);
    } catch {
      return false;
    }
    if (info.isDirectory()) {
      let children: string[];
      try {
        children = readdirSync(path);
      } catch {
        return false;
      }
      return children.some((name) => visit(join(path, name)));
    }
    bytes += info.size;
    return bytes > 128 * 1024 * 1024;
  };
  return visit(root);
}

async function command(
  executable: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
  limits?: {
    readonly outputFile?: string;
    readonly maxOutputBytes?: number;
    readonly temporaryDirectory?: string;
  },
): Promise<string> {
  signal?.throwIfAborted();
  // Do not interpolate selectors into a shell, including on Windows.
  let launch = { executable, args };
  if (process.platform === "win32" && ["npm", "pnpm"].includes(executable)) {
    const candidates = [dirname(process.execPath), ...(process.env.PATH ?? "").split(delimiter)];
    const scripts =
      executable === "npm"
        ? ["node_modules/npm/bin/npm-cli.js", "node_modules/corepack/dist/npm.js"]
        : ["node_modules/pnpm/bin/pnpm.cjs", "node_modules/corepack/dist/pnpm.js", "pnpm.cjs"];
    const launcher = candidates
      .flatMap((directory) => scripts.map((script) => join(directory, script)))
      .find((path) => existsSync(path) && lstatSync(path).isFile());
    const standalone = candidates
      .map((directory) => join(directory, `${executable}.exe`))
      .find((path) => existsSync(path) && lstatSync(path).isFile());
    if (launcher) launch = { executable: process.execPath, args: [launcher, ...args] };
    else if (standalone) launch = { executable: standalone, args };
    else
      fail(
        `Cannot find a direct ${executable} Node or executable launcher.`,
        "Install npm or pnpm with Node/Corepack, or install the reviewed package manually with --ignore-scripts and select its package name. Shell launcher files are deliberately not evaluated.",
      );
  }
  return new Promise((resolveCommand, reject) => {
    const child = spawn(launch.executable, launch.args, {
      cwd,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "ignore"],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_NOSYSTEM: "1",
        npm_config_ignore_scripts: "true",
      },
    });
    const output: Buffer[] = [];
    let outputBytes = 0;
    let exceeded = false;
    const kill = () => {
      if (process.platform !== "win32" && child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      } else child.kill("SIGKILL");
    };
    const timeout = setTimeout(() => {
      exceeded = true;
      kill();
    }, 120_000);
    const watchdog =
      limits?.temporaryDirectory === undefined
        ? undefined
        : setInterval(() => {
            if (limits.temporaryDirectory !== undefined && temporarySizeExceeded(limits.temporaryDirectory)) {
              exceeded = true;
              kill();
            }
          }, 100);
    const abort = kill;
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout?.on("data", (bytes: Buffer) => {
      outputBytes += bytes.length;
      if (outputBytes > (limits?.maxOutputBytes ?? 2 * 1024 * 1024)) {
        exceeded = true;
        kill();
      } else output.push(bytes);
    });
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (watchdog) clearInterval(watchdog);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else {
        const bytes = Buffer.concat(output);
        if (limits?.outputFile !== undefined) {
          try {
            writeFileSync(limits.outputFile, bytes, { flag: "wx" });
          } catch (cause) {
            reject(cause);
            return;
          }
          resolveCommand("");
        } else resolveCommand(bytes.toString("utf8"));
      }
    };
    child.once("error", () =>
      finish(
        new FiredrillToolInstallationError(
          `Could not start ${executable}.`,
          `Install ${executable} and retry, or install a reviewed package manually with lifecycle scripts disabled.`,
        ),
      ),
    );
    child.once("close", (code) =>
      finish(
        code === 0 && !signal?.aborted && !exceeded
          ? undefined
          : new FiredrillToolInstallationError(
              signal?.aborted
                ? "Tool installation was cancelled."
                : `${executable} could not complete Tool acquisition or installation.`,
              exceeded
                ? "Use a smaller package or check network access; the command exceeded its time or output bound."
                : "Check registry/Git access and package dependencies. No Tool was selected. Package-manager changes may remain; inspect package.json and its lock before retrying.",
            ),
      ),
    );
    if (signal?.aborted) abort();
  });
}

function unsafeFile(path: string, bytes: Buffer): boolean {
  return (
    path
      .split("/")
      .some((part) =>
        [
          ".git",
          ".firedrill",
          ".firedrill-tools",
          "node_modules",
          "reports",
          ".npmrc",
          ".netrc",
          ".pypirc",
        ].includes(part),
      ) ||
    /(^|\/)\.env(?:\.|$)|\.(?:key|p12|pfx|pem)$/i.test(path) ||
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{20,}|\bsk-[A-Za-z0-9_-]{20,}|https?:\/\/[^\s/:]+:[^\s/@]+@|\bAKIA[0-9A-Z]{16}\b|\bxox[baprs]-[A-Za-z0-9-]{10,}\b|\bAIza[0-9A-Za-z_-]{30,}\b/.test(
      bytes.toString("utf8"),
    )
  );
}

/** Parse bounded bytes first and write regular files ourselves; never delegate archive path traversal to extraction. */
function unpack(
  archive: string,
  destination: string,
  npmPackage: boolean,
  staging: string,
): Map<string, Buffer> {
  const stat = lstatSync(archive);
  if (!stat.isFile() || stat.size > MAX_ARCHIVE_BYTES)
    fail(
      "Tool archive is not a regular file or exceeds 32 MiB.",
      "Publish a smaller source-only Tool package.",
    );
  const packed = readFileSync(archive);
  const bytes =
    packed[0] === 0x1f && packed[1] === 0x8b
      ? gunzipSync(packed, { maxOutputLength: MAX_EXPANDED_BYTES })
      : packed;
  if (bytes.length > MAX_EXPANDED_BYTES)
    fail(
      "Expanded Tool archive exceeds 64 MiB.",
      "Remove generated data and unused assets from the package.",
    );
  const plain = join(staging, `unpack-${createHash("sha256").update(bytes).digest("hex")}.tar`);
  if (!existsSync(plain)) writeFileSync(plain, bytes, { flag: "wx" });
  const files = new Map<string, Buffer>();
  let total = 0;
  let entries = 0;
  list({
    file: plain,
    sync: true,
    strict: true,
    onReadEntry(entry) {
      if (++entries > MAX_FILES)
        fail("Tool archive contains too many entries.", "Limit the package to 4,096 files and directories.");
      let path = entry.path.replace(/\/$/, "");
      if (npmPackage) {
        if (path === "package" && entry.type === "Directory") return;
        if (!path.startsWith("package/"))
          fail(
            "Tool archive has an unexpected package root.",
            "Use a standard npm package archive with a package/ root; review lifecycle scripts before packing.",
          );
        path = path.slice(8);
      }
      if (!safeSegments(path) || (entry.type !== "File" && entry.type !== "Directory"))
        fail(
          "Tool archive contains a link, special file, or unsafe path.",
          "Ship only regular files inside the package; links and parent traversal are not accepted.",
        );
      if (entry.type === "Directory") return;
      total += entry.size;
      if (files.has(path) || entry.size > MAX_FILE_BYTES || total > MAX_EXPANDED_BYTES)
        fail(
          "Tool archive exceeds bounds or repeats a file path.",
          "Use distinct files smaller than 16 MiB and a package smaller than 64 MiB expanded.",
        );
      const chunks: Buffer[] = [];
      entry.on("data", (chunk: Buffer) => chunks.push(chunk));
      entry.on("end", () => {
        const content = Buffer.concat(chunks);
        // Raw Git source is private staging, not the distributable package. Honor
        // the author's npm files allowlist first, then enforce this policy on
        // every file that would actually be installed or vendored.
        if (npmPackage && unsafeFile(path, content))
          fail(
            "Tool package includes generated data or a secret-bearing file.",
            "Review the package files allowlist and remove credentials, reports, dependencies, and generated state before installing.",
          );
        files.set(path, content);
      });
    },
  });
  if (!files.size)
    fail("The Tool archive is empty.", "Include package.json, the Tool declaration, and behavior source.");
  for (const [path, content] of files) {
    const target = join(destination, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, { flag: "wx", mode: 0o644 });
  }
  return files;
}

async function pack(source: string, cwd: string, destination: string, signal?: AbortSignal): Promise<string> {
  const output = await command(
    "npm",
    [
      "pack",
      "--ignore-scripts",
      "--json",
      "--cache",
      join(destination, "npm-cache"),
      "--pack-destination",
      destination,
      source,
    ],
    cwd,
    signal,
    { temporaryDirectory: destination },
  );
  const result: unknown = JSON.parse(output);
  const filename = Array.isArray(result) ? result[0]?.filename : undefined;
  if (typeof filename !== "string" || basename(filename) !== filename || !filename.endsWith(".tgz"))
    fail("npm did not return one package archive.", "Use a single Tool package selector.");
  return join(destination, filename);
}

/** npm 10 can run local prepare hooks during pack despite --ignore-scripts. */
function stageScriptlessPackage(source: string, destination: string): string {
  checkTree(source);
  cpSync(source, destination, {
    recursive: true,
    filter: (path) =>
      !relative(source, path)
        .split(sep)
        .some((part) => part === ".git" || part === "node_modules"),
  });
  checkTree(destination);
  const manifestPath = join(destination, "package.json");
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    fail("Tool package has no readable package.json.", "Use a standalone npm package directory.");
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
    fail("Tool package has no valid package.json.", "Use a standalone npm package directory.");
  delete (manifest as { scripts?: unknown }).scripts;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return destination;
}

function writeImmutable(path: string, bytes: Buffer | string): void {
  assertNoLinks(dirname(path));
  if (existsSync(path)) {
    if (!lstatSync(path).isFile() || !readFileSync(path).equals(Buffer.from(bytes)))
      fail(
        "An existing vendored Tool artifact does not match its content address.",
        "Review .firedrill-tools/ before retrying; Firedrill will not overwrite source dependencies.",
      );
  } else writeFileSync(path, bytes, { flag: "wx", mode: 0o644 });
}

/** Acquisition only: caller supplies explicit installation consent and selects the package separately. */
export async function installToolSource(options: InstallToolSourceOptions): Promise<ToolInstallation> {
  const staged = mkdtempSync(join(tmpdir(), "firedrill-tool-install-"));
  try {
    const root = realpathSync(options.root);
    const source = parseSource(root, options.source);
    if (options.signal?.aborted) fail("Tool installation was cancelled.", "Retry installation when ready.");
    let archive: string;
    let resolvedSource: string;
    const label = source.kind === "npm" ? source.selector : source.label;
    if (source.kind === "git") {
      const checkout = join(staged, "git");
      mkdirSync(checkout);
      const git = [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "protocol.ext.allow=never",
        "-c",
        "protocol.file.allow=always",
      ];
      await command("git", [...git, "init", "--quiet"], checkout, options.signal);
      await command(
        "git",
        [
          ...git,
          "fetch",
          "--quiet",
          "--depth=1",
          "--no-tags",
          "--no-recurse-submodules",
          source.url,
          source.ref,
        ],
        checkout,
        options.signal,
        { temporaryDirectory: checkout },
      );
      const commit = (
        await command(
          "git",
          [...git, "rev-parse", "--verify", "FETCH_HEAD^{commit}"],
          checkout,
          options.signal,
        )
      ).trim();
      if (!/^[a-f0-9]{40,64}$/.test(commit))
        fail("Git did not resolve an exact commit.", "Use an existing full commit hash.");
      const repositoryArchive = join(staged, "repository.tar");
      await command(
        "git",
        [...git, "archive", "--format=tar", `${commit}${source.directory ? `:${source.directory}` : ""}`],
        checkout,
        options.signal,
        { outputFile: repositoryArchive, maxOutputBytes: MAX_ARCHIVE_BYTES, temporaryDirectory: checkout },
      );
      const packageRoot = join(staged, "git-package");
      unpack(repositoryArchive, packageRoot, false, staged);
      archive = await pack(
        stageScriptlessPackage(packageRoot, join(staged, "git-safe")),
        root,
        staged,
        options.signal,
      );
      resolvedSource = `${source.url.startsWith("file:") ? "local-git" : source.url}#${commit}${source.directory ? `::${source.directory}` : ""}`;
    } else if (source.kind === "local") {
      assertNoLinks(source.path);
      if (lstatSync(source.path).isDirectory()) {
        checkTree(source.path);
        archive = await pack(
          stageScriptlessPackage(source.path, join(staged, "local-safe")),
          root,
          staged,
          options.signal,
        );
      } else {
        if (!lstatSync(source.path).isFile() || lstatSync(source.path).size > MAX_ARCHIVE_BYTES)
          fail("Tool archive is not a bounded regular file.", "Use an npm .tgz package smaller than 32 MiB.");
        archive = join(staged, "local-package.tgz");
        writeFileSync(archive, readFileSync(source.path), { flag: "wx" });
      }
      resolvedSource = "";
    } else {
      archive = await pack(source.selector, root, staged, options.signal);
      resolvedSource = "";
    }
    const candidate = join(staged, "candidate");
    const files = unpack(archive, candidate, true, staged);
    const manifest: unknown = JSON.parse(readFileSync(join(candidate, "package.json"), "utf8"));
    const packageName = NodePackageNameSchema.parse((manifest as { name?: unknown }).name);
    const version = SemverSchema.parse((manifest as { version?: unknown }).version);
    // Resolve through the same compiler path used by real consumers, without installing or importing code.
    const inspectionRoot = join(staged, "inspect");
    const installedCandidate = join(inspectionRoot, "node_modules", packageName);
    mkdirSync(installedCandidate, { recursive: true });
    for (const [path, content] of files) {
      const target = join(installedCandidate, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, { flag: "wx" });
    }
    const inspected = inspectInstalledToolPackage({ repositoryRoot: inspectionRoot, packageName });
    if (inspected.status !== "success")
      fail(
        "The acquired package is not a compatible, inspectable Firedrill Tool.",
        inspected.diagnostics.map((item) => `${item.code}: ${item.message}`).join("; "),
      );
    const archiveBytes = readFileSync(archive);
    const digest = createHash("sha256").update(archiveBytes).digest("hex");
    const integrity = `sha512-${createHash("sha512").update(archiveBytes).digest("base64")}`;
    resolvedSource ||= source.kind === "npm" ? `${packageName}@${version}` : `sha256:${digest}`;
    const packageManager = existsSync(join(root, "pnpm-lock.yaml")) ? "pnpm" : "npm";
    let archivePath: string | undefined;
    let provenancePath: string | undefined;
    let dependency = `${packageName}@${version}`;
    if (source.kind !== "npm") {
      const vendorRoot = join(root, ".firedrill-tools");
      mkdirSync(vendorRoot, { recursive: true });
      assertNoLinks(vendorRoot);
      archivePath = `.firedrill-tools/${digest}.tgz`;
      provenancePath = `.firedrill-tools/${digest}.json`;
      writeImmutable(join(root, archivePath), archiveBytes);
      writeImmutable(
        join(root, provenancePath),
        `${JSON.stringify({ schemaVersion: 1, packageName, version, resolvedSource, integrity }, null, 2)}\n`,
      );
      dependency = `file:${archivePath}`;
    }
    await command(
      packageManager,
      packageManager === "pnpm"
        ? ["add", "--save-dev", "--save-exact", "--ignore-scripts", dependency]
        : [
            // cwd alone lets npm walk to an ancestor package when this is a new,
            // non-Node project. Keep dependency writes inside the requested root.
            "--prefix",
            root,
            "install",
            "--save-dev",
            "--save-exact",
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
            dependency,
          ],
      root,
      options.signal,
    );
    const selected = inspectInstalledToolPackage({ repositoryRoot: root, packageName });
    if (selected.status !== "success" || selected.package.version !== version)
      fail(
        "The installed Tool does not match the reviewed package version.",
        "Check dependency overrides and the package-manager lock before selecting the Tool.",
      );
    const resolver = createRequire(join(root, "package.json"));
    const installedRoot = dirname(realpathSync(resolver.resolve(`${packageName}/package.json`)));
    const installedFiles: string[] = [];
    let installedEntries = 0;
    const collect = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === "node_modules") continue;
        if (++installedEntries > MAX_FILES)
          fail(
            "Installed Tool contains too many entries.",
            "Check registry integrity and dependency overrides.",
          );
        const absolute = join(directory, entry.name);
        if (entry.isDirectory()) collect(absolute);
        else {
          if (!entry.isFile())
            fail(
              "Installed Tool contains a link or special file.",
              "Inspect the installed package before selecting it.",
            );
          installedFiles.push(relative(installedRoot, absolute).split(sep).join("/"));
          if (installedFiles.length > MAX_FILES)
            fail(
              "Installed Tool contains unexpected extra files.",
              "Check registry integrity and dependency overrides.",
            );
        }
      }
    };
    collect(installedRoot);
    if (JSON.stringify(installedFiles.sort()) !== JSON.stringify([...files.keys()].sort()))
      fail(
        "Installed Tool file set differs from the reviewed package archive.",
        "The registry or dependency overrides returned different content; no Tool was selected.",
      );
    for (const [path, bytes] of files) {
      const target = join(installedRoot, path);
      assertNoLinks(target, installedRoot);
      if (!readFileSync(target).equals(bytes))
        fail(
          "Installed Tool bytes differ from the acquired package archive.",
          "Check registry integrity and dependency overrides; the Tool has not been selected.",
        );
    }
    if (packageManager === "npm") {
      const lock: unknown = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
      const entry = (lock as { packages?: Record<string, { integrity?: unknown }> }).packages?.[
        `node_modules/${packageName}`
      ];
      if (entry?.integrity !== integrity)
        fail(
          "The npm lock integrity differs from the reviewed Tool archive.",
          "Check registry integrity before selecting the Tool; commit only a reviewed package lock.",
        );
    }
    return {
      packageName,
      version,
      source: label,
      resolvedSource,
      integrity,
      packageManager,
      ...(archivePath ? { archivePath } : {}),
      ...(provenancePath ? { provenancePath } : {}),
    };
  } catch (error) {
    if (error instanceof FiredrillToolInstallationError) throw error;
    // Parser, filesystem, and package-manager messages may contain private paths or URL credentials.
    throw new FiredrillToolInstallationError(
      "The Tool source could not be read or validated safely.",
      "Check the package path, Firedrill metadata, files allowlist, and archive bounds. No Tool was selected.",
    );
  } finally {
    rmSync(staged, { recursive: true, force: true });
  }
}
