import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { JsonObjectSchema, canonicalJson } from "@firedrill/contracts";
import type { JsonObject, JsonValue } from "@firedrill/contracts";

export function encodeJson(value: JsonValue): string {
  return canonicalJson(value);
}

export function decodeObject(value: string): JsonObject {
  return JsonObjectSchema.parse(JSON.parse(value));
}

export function decodeStoredCount(value: string, field: string): number {
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new TypeError(`stored ${field} is not a non-negative integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new RangeError(`stored ${field} exceeds the safe integer range`);
  }
  return parsed;
}

export function hashJson(value: JsonValue): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

export function hashFile(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}
