import { createHash } from "node:crypto";
import { Sha256Schema, canonicalJson } from "@firedrill/contracts";
import type { JsonValue, Sha256 } from "@firedrill/contracts";

export function sha256Text(value: string | Uint8Array): Sha256 {
  return Sha256Schema.parse(`sha256:${createHash("sha256").update(value).digest("hex")}`);
}

export function semanticHash(value: unknown): Sha256 {
  return sha256Text(canonicalJson(value as JsonValue));
}
