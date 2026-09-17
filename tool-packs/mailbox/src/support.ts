import {
  type ToolContext,
  ToolFailure,
  type ToolHttpOperationInput,
  type ToolHttpRouteCodec,
  type ToolOperationHandler,
} from "@firedrill-tools/tool-sdk";

type Input = Parameters<ToolOperationHandler>[0];
type RecordValue = ToolHttpOperationInput["arguments"];

export function failure(code: string): never {
  throw new ToolFailure({
    code,
    message:
      (
        {
          NOT_FOUND: "The actor-owned record does not exist.",
          CONFLICT: "The supplied version does not match, or the version limit was reached.",
          INVALID_STATE: "Only drafts can be written or sent.",
          INVALID_CURSOR: "The cursor is malformed or does not match this actor and filter.",
        } as Record<string, string>
      )[code] ?? "The operation was refused.",
  });
}

export function nextVersion(input: Input, previous: Readonly<RecordValue> | null): number {
  const current = previous?.version ?? 0;
  if (
    (input.ifVersion !== undefined && input.ifVersion !== current) ||
    typeof current !== "number" ||
    current >= 2147483647
  )
    failure("CONFLICT");
  return current + 1;
}

/** Live lexicographic pages filter at most 1,000 rows, plus one bounded continuation lookahead. */
export function page(
  context: ToolContext,
  namespace: string,
  input: Input,
  scope: string,
  filter: (value: Readonly<RecordValue>) => boolean,
  summarize: (value: Readonly<RecordValue>) => RecordValue,
): RecordValue {
  const actorPrefix = `${context.actor.id}:`;
  let after = actorPrefix;
  if (input.cursor !== undefined) {
    try {
      const cursor = JSON.parse(String(input.cursor)) as { scope?: unknown; after?: unknown };
      if (
        cursor === null ||
        typeof cursor !== "object" ||
        Array.isArray(cursor) ||
        Object.keys(cursor).sort().join(",") !== "after,scope" ||
        cursor.scope !== scope ||
        typeof cursor.after !== "string" ||
        !cursor.after.startsWith(actorPrefix) ||
        cursor.after.length > 1024
      )
        failure("INVALID_CURSOR");
      after = cursor.after;
    } catch {
      failure("INVALID_CURSOR");
    }
  }
  const limit = typeof input.limit === "number" ? input.limit : 50;
  const items: RecordValue[] = [];
  let scanned = 0;
  while (items.length < limit && scanned < 1000) {
    const rows = context.state.scan(namespace, { afterRowId: after, limit: Math.min(100, 1000 - scanned) });
    if (rows.length === 0) return { items };
    for (const row of rows) {
      if (!row.rowId.startsWith(actorPrefix)) return { items };
      after = row.rowId;
      scanned += 1;
      if (row.value.ownerId === context.actor.id && filter(row.value)) items.push(summarize(row.value));
      if (items.length >= limit || scanned >= 1000) break;
    }
  }
  const next = context.state.scan(namespace, { afterRowId: after, limit: 1 })[0];
  return {
    items,
    ...(next?.rowId.startsWith(actorPrefix) ? { nextCursor: JSON.stringify({ scope, after }) } : {}),
  };
}

function single(values: readonly string[] | undefined, field: string): string | undefined {
  if (values === undefined) return undefined;
  if (values.length !== 1) throw new TypeError(`${field} must be supplied once`);
  return values[0];
}

/** The codec owns wire spelling only; validation, state and idempotency belong to the world. */
export function route(
  queryKeys: readonly string[],
  mutate: boolean,
  json: boolean,
  pathId = false,
): ToolHttpRouteCodec {
  return {
    decode(request) {
      if (Object.keys(request.query).some((key) => !queryKeys.includes(key)))
        throw new TypeError("Unknown query field");
      const args: RecordValue = {};
      if (json) {
        if (
          request.body.kind !== "json" ||
          request.body.value === null ||
          typeof request.body.value !== "object" ||
          Array.isArray(request.body.value)
        )
          throw new TypeError("JSON object required");
        Object.assign(args, request.body.value);
      }
      if (pathId) {
        if (args.id !== undefined) throw new TypeError("id belongs in the path");
        args.id = request.path.id ?? "";
      }
      for (const field of queryKeys) {
        const value = single(request.query[field], field);
        if (value === undefined) continue;
        if (args[field] !== undefined) throw new TypeError("Duplicate argument");
        if (field === "limit" || field === "ifVersion") {
          if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value)))
            throw new TypeError(`${field} must be an integer`);
          args[field] = Number(value);
        } else args[field] = value;
      }
      if (!mutate) return { arguments: args };
      const idempotencyKey = single(request.headers["idempotency-key"], "idempotency-key");
      if (!idempotencyKey) throw new TypeError("idempotency-key is required");
      return { arguments: args, idempotencyKey };
    },
    encode({ outcome }) {
      return {
        body: {
          kind: "json",
          value:
            outcome.status === "ok"
              ? (outcome.value ?? null)
              : {
                  error: {
                    code: outcome.error?.code ?? "REQUEST_FAILED",
                    message: outcome.error?.message ?? "Request failed",
                  },
                },
        },
      };
    },
  };
}
