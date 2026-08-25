import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const source = resolve(repositoryRoot, "skills/firedrill");
const destination = resolve(packageRoot, "dist/skill");

if (!existsSync(source)) throw new Error(`required Firedrill skill is missing: ${source}`);
rmSync(destination, { recursive: true, force: true });
mkdirSync(dirname(destination), { recursive: true });
cpSync(source, destination, { recursive: true, errorOnExist: true });
