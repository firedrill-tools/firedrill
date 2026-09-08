import type { LocalWorldTool } from "@firedrill/sdk";

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sensitive(name: string, declared: ReadonlySet<string>): boolean {
  const parts = name
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/);
  return (
    declared.has(name) ||
    parts.some((part) =>
      ["authorization", "cookie", "credential", "passwd", "password", "secret", "token"].includes(part),
    ) ||
    (parts.includes("key") && parts.some((part) => ["api", "access", "private"].includes(part)))
  );
}

function declaredNames(schema: unknown, names: Set<string>): void {
  if (Array.isArray(schema)) {
    for (const value of schema) declaredNames(value, names);
  } else if (object(schema)) {
    if (object(schema.properties)) {
      for (const [name, value] of Object.entries(schema.properties))
        if (
          object(value) &&
          (value.writeOnly === true || value["x-firedrill-sensitive"] === true || value.format === "password")
        )
          names.add(name);
    }
    for (const value of Object.values(schema)) declaredNames(value, names);
  }
}

/** Presentation-only field redaction. The private SQLite journal remains unchanged and unredacted. */
export function redactEnvironmentValue(
  value: unknown,
  tools: readonly LocalWorldTool[],
  credentials: readonly string[],
): unknown {
  const names = new Set<string>();
  for (const tool of tools) {
    declaredNames(tool.operationContracts, names);
    declaredNames(tool.stateContracts, names);
  }
  const secrets = new Set(credentials.filter((credential) => credential.length > 0));
  // Preserve journal identities and pagination fields even if a Tool declares a
  // payload field with the same name (for example namespace or operationId).
  const payloadKeys = new Set([
    "actual",
    "after",
    "arguments",
    "attributes",
    "before",
    "details",
    "expected",
    "input",
    "output",
    "payload",
    "value",
  ]);
  const collectStrings = (item: unknown): void => {
    if (typeof item === "string" && item.length >= 8) secrets.add(item);
    else if (Array.isArray(item)) item.forEach(collectStrings);
    else if (object(item)) Object.values(item).forEach(collectStrings);
  };
  const collect = (item: unknown, insidePayload = false): void => {
    if (Array.isArray(item)) {
      for (const child of item) collect(child, insidePayload);
    } else if (object(item))
      for (const [key, child] of Object.entries(item)) {
        const payload = insidePayload || payloadKeys.has(key);
        if (payload && sensitive(key, names)) collectStrings(child);
        else collect(child, payload);
      }
  };
  collect(value);
  const propagated = [...secrets].sort((left, right) => right.length - left.length);
  const textKeys = new Set(["description", "instruction", "message", "note", "reason", "text"]);
  const visit = (item: unknown, insidePayload = false, textField = false): unknown => {
    if (typeof item === "string") {
      for (const secret of insidePayload || textField ? propagated : credentials)
        if (secret.length > 0) item = (item as string).replaceAll(secret, "[REDACTED]");
      return item;
    }
    if (Array.isArray(item)) return item.map((child) => visit(child, insidePayload));
    if (object(item))
      return Object.fromEntries(
        Object.entries(item).map(([key, child]) => {
          const payload = insidePayload || payloadKeys.has(key);
          return [
            key,
            payload && sensitive(key, names) ? "[REDACTED]" : visit(child, payload, textKeys.has(key)),
          ];
        }),
      );
    return item;
  };
  return visit(value);
}
