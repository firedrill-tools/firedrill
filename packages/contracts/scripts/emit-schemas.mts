import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ContractSchemas } from "../src/schemas.js";

const outputDirectory = fileURLToPath(new URL("../dist/schema/", import.meta.url));
const packageLicense = fileURLToPath(new URL("../dist/LICENSE", import.meta.url));
const packageNotice = fileURLToPath(new URL("../dist/NOTICE", import.meta.url));
const repositoryLicense = fileURLToPath(new URL("../../../LICENSE", import.meta.url));
const repositoryNotice = fileURLToPath(new URL("../../../NOTICE", import.meta.url));
rmSync(outputDirectory, { force: true, recursive: true });
mkdirSync(outputDirectory, { recursive: true });
copyFileSync(repositoryLicense, packageLicense);
copyFileSync(repositoryNotice, packageNotice);

const kebab = (name: string) => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

for (const [name, schema] of Object.entries(ContractSchemas)) {
  const fileName = `${kebab(name)}.json`;
  const document = z.toJSONSchema(schema, { target: "draft-2020-12" });
  const withIdentity = {
    $id: `https://firedrill.run/schema/v1/${fileName}`,
    ...document,
  };
  writeFileSync(`${outputDirectory}/${fileName}`, `${JSON.stringify(withIdentity, null, 2)}\n`);
}
