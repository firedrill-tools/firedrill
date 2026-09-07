import type { SimulationSetup } from "../types.js";

export interface StartingRecord {
  readonly packageId: string;
  readonly namespace: string;
  readonly rowId: string;
  readonly value: Extract<SimulationSetup["state"][number], { action: "upsert" }>["value"];
}

/** A resolved scenario already includes baseline patches. Later upserts replace complete rows. */
export function startingRecords(setup: SimulationSetup): readonly StartingRecord[] {
  const rows = new Map<string, StartingRecord>();
  for (const patch of setup.state) {
    const key = JSON.stringify([patch.packageId, patch.namespace, patch.rowId]);
    if (patch.action === "delete") rows.delete(key);
    else
      rows.set(key, {
        packageId: patch.packageId,
        namespace: patch.namespace,
        rowId: patch.rowId,
        value: patch.value,
      });
  }
  return [...rows.values()].sort((a, b) => {
    const left = JSON.stringify([a.packageId, a.namespace, a.rowId]);
    const right = JSON.stringify([b.packageId, b.namespace, b.rowId]);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

export function recordCell(value: unknown): string {
  if (value === undefined) return "—";
  if (value === null) return "null";
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`;
  if (typeof value === "object") return "Object";
  return String(value);
}

export function schemaFields(
  schema: Record<string, unknown>,
): readonly { name: string; type: string; required: boolean; definition: unknown }[] {
  const properties = schema.properties;
  if (typeof properties !== "object" || properties === null || Array.isArray(properties)) return [];
  const required = Array.isArray(schema.required) ? schema.required : [];
  return Object.entries(properties).map(([name, definition]) => {
    const field =
      typeof definition === "object" && definition !== null ? (definition as Record<string, unknown>) : {};
    const type =
      typeof field.$ref === "string"
        ? field.$ref
        : Array.isArray(field.type)
          ? field.type.join(" | ")
          : typeof field.type === "string"
            ? field.type
            : field.enum !== undefined
              ? "enum"
              : "See definition";
    return { name, type, required: required.includes(name), definition };
  });
}
