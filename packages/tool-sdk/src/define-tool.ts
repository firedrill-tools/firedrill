import { ToolPackageManifestSchema } from "@firedrill-tools/contracts";
import type { ToolDefinition, ToolDefinitionInput } from "./types.js";
import { defineToolBehavior } from "./define-behavior.js";

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return value;
  const object = value as object;
  if (seen.has(object)) return value;
  seen.add(object);
  for (const child of Object.values(object)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function assertExactHandlers(kind: string, declared: readonly string[], provided: readonly string[]): void {
  const expected = new Set(declared);
  const actual = new Set(provided);
  const missing = declared.filter((id) => !actual.has(id));
  const extra = provided.filter((id) => !expected.has(id));
  if (missing.length === 0 && extra.length === 0) return;

  const details = [
    missing.length > 0 ? `missing: ${missing.join(", ")}` : undefined,
    extra.length > 0 ? `undeclared: ${extra.join(", ")}` : undefined,
  ].filter((part): part is string => part !== undefined);
  throw new TypeError(`${kind} handlers do not match the manifest (${details.join("; ")})`);
}

/**
 * Validates the package manifest and proves every declared executable surface has exactly one handler.
 * Tool code is trusted local code; defineTool is a contract check, not a sandbox.
 */
export function defineTool(input: ToolDefinitionInput): ToolDefinition {
  const manifest = ToolPackageManifestSchema.parse(input.manifest);
  const behavior = defineToolBehavior({
    operations: input.operations,
    ...(input.subscriptions === undefined ? {} : { subscriptions: input.subscriptions }),
    ...(input.http === undefined ? {} : { http: input.http }),
    ...(input.callbacks === undefined ? {} : { callbacks: input.callbacks }),
  });
  assertExactHandlers(
    "operation",
    manifest.operations.map((operation) => operation.id),
    Object.keys(behavior.operations),
  );
  assertExactHandlers(
    "subscription",
    manifest.subscriptions.map((subscription) => subscription.id),
    Object.keys(behavior.subscriptions ?? {}),
  );
  assertExactHandlers(
    "HTTP route",
    manifest.http.map((route) => route.id),
    Object.keys(behavior.http ?? {}),
  );
  assertExactHandlers(
    "callback",
    manifest.callbacks.map((callback) => callback.id),
    Object.keys(behavior.callbacks ?? {}),
  );

  return Object.freeze({
    manifest: deepFreeze(manifest),
    operations: behavior.operations,
    subscriptions: behavior.subscriptions ?? {},
    http: behavior.http ?? {},
    callbacks: behavior.callbacks ?? {},
  });
}
