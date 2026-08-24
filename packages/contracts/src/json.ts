import { z } from "zod";

export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export const JsonObjectSchema: z.ZodType<JsonObject> = z.record(z.string(), JsonValueSchema);

/**
 * Stable JSON serialization for semantic hashes and reproducible artifacts.
 * Object keys are sorted recursively; array order remains meaningful.
 */
export function canonicalJson(value: JsonValue): string {
  const active = new Set<object>();

  const normalize = (item: unknown): JsonValue => {
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new TypeError("canonical JSON rejects non-finite numbers");
      return Object.is(item, -0) ? 0 : item;
    }
    if (item === undefined) throw new TypeError("canonical JSON rejects undefined values");
    if (typeof item !== "object") {
      throw new TypeError(`canonical JSON rejects ${typeof item} values`);
    }
    if (active.has(item)) throw new TypeError("canonical JSON rejects cyclic values");
    active.add(item);
    try {
      if (Array.isArray(item)) return item.map(normalize);
      return Object.fromEntries(
        Object.entries(item)
          .filter(([, child]) => child !== undefined)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, normalize(child)]),
      );
    } finally {
      active.delete(item);
    }
  };

  return JSON.stringify(normalize(value));
}
