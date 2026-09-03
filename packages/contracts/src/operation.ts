import { z } from "zod";
import {
  ActorBindingIdSchema,
  CallIdSchema,
  CorrelationIdSchema,
  EventIdSchema,
  EventRefSchema,
  NodePackageNameSchema,
  OperationIdSchema,
  OperationRefSchema,
  PackageIdSchema,
  SemverSchema,
  StableIdSchema,
  VirtualTimeSchema,
} from "./identifiers.js";
import { ErrorEnvelopeSchema } from "./errors.js";
import { JsonObjectSchema, JsonValueSchema } from "./json.js";

export const FidelitySchema = z.enum(["contract", "stateful", "behavioral", "validated"]);

export const ToolCapabilitySchema = z.enum([
  "state.read",
  "state.write",
  "clock.read",
  "clock.schedule",
  "random.draw",
  "event.emit",
]);

export const OperationContractSchema = z
  .object({
    id: OperationIdSchema,
    description: z.string().min(1).max(1000).optional(),
    inputSchema: JsonObjectSchema,
    outputSchema: JsonObjectSchema,
    declaredErrors: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).default([]),
    idempotency: z.enum(["none", "optional", "required"]),
    fidelity: FidelitySchema,
  })
  .strict();

export const ToolEventContractSchema = z
  .object({
    id: EventIdSchema,
    payloadSchema: JsonObjectSchema,
  })
  .strict();

export const ToolStateContractSchema = z
  .object({
    namespace: StableIdSchema,
    schema: JsonObjectSchema,
    description: z.string().min(1).max(1000).optional(),
  })
  .strict();

export const ToolFaultContractSchema = z
  .object({
    id: StableIdSchema,
    appliesTo: z.array(OperationIdSchema).min(1),
    timing: z.enum(["before", "after_commit"]),
    error: z
      .object({
        code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
        message: z.string().min(1).max(1000),
        retryable: z.boolean(),
      })
      .strict(),
  })
  .strict();

export const ToolSubscriptionContractSchema = z
  .object({
    id: StableIdSchema,
    event: EventRefSchema,
  })
  .strict();

export const HttpMethodSchema = z.enum(["DELETE", "GET", "PATCH", "POST", "PUT"]);

const HTTP_PATH_LITERAL = /^[A-Za-z0-9._~-]+$/;
const HTTP_PATH_PARAMETER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HTTP_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

/** Splits one validated OpenAPI-style path template into literal and parameter segments. */
export function httpPathSegments(path: string): readonly string[] {
  if (path === "/") return [];
  return path.slice(1).split("/");
}

export function httpPathParameter(segment: string): string | undefined {
  if (!segment.startsWith("{") || !segment.endsWith("}")) return undefined;
  return segment.slice(1, -1);
}

/** True when two templates can match the same concrete path. */
export function httpRoutesOverlap(
  left: { readonly method: string; readonly path: string },
  right: { readonly method: string; readonly path: string },
): boolean {
  if (left.method !== right.method) return false;
  const leftSegments = httpPathSegments(left.path);
  const rightSegments = httpPathSegments(right.path);
  if (leftSegments.length !== rightSegments.length) return false;
  return leftSegments.every((segment, index) => {
    const other = rightSegments[index];
    return (
      other !== undefined &&
      (httpPathParameter(segment) !== undefined ||
        httpPathParameter(other) !== undefined ||
        segment === other)
    );
  });
}

const FRAMEWORK_HTTP_ROUTES = [
  { method: "GET", path: "/health" },
  { method: "GET", path: "/v1/tools" },
  { method: "POST", path: "/v1/operations/{packageId}/{operationId}" },
] as const;

/** True when a Tool route could shadow a framework-owned world-binding route. */
export function httpRouteConflictsWithFramework(route: {
  readonly method: string;
  readonly path: string;
}): boolean {
  return FRAMEWORK_HTTP_ROUTES.some((reserved) => httpRoutesOverlap(route, reserved));
}

export const HttpPathTemplateSchema = z
  .string()
  .min(1)
  .max(512)
  .superRefine((path, context) => {
    if (!path.startsWith("/")) {
      context.addIssue({ code: "custom", message: "HTTP route path must start with /" });
      return;
    }
    if (path.length > 1 && path.endsWith("/")) {
      context.addIssue({ code: "custom", message: "HTTP route path must not end with /" });
    }
    if (path.includes("?") || path.includes("#")) {
      context.addIssue({ code: "custom", message: "HTTP route path cannot contain a query or fragment" });
    }
    const parameters = new Set<string>();
    for (const [index, segment] of httpPathSegments(path).entries()) {
      const parameter = httpPathParameter(segment);
      if (parameter !== undefined) {
        if (!HTTP_PATH_PARAMETER.test(parameter)) {
          context.addIssue({
            code: "custom",
            path: [index],
            message: `invalid HTTP path parameter ${parameter}`,
          });
        } else if (parameters.has(parameter)) {
          context.addIssue({
            code: "custom",
            path: [index],
            message: `duplicate HTTP path parameter ${parameter}`,
          });
        }
        parameters.add(parameter);
      } else if (!HTTP_PATH_LITERAL.test(segment)) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: `invalid HTTP path segment ${segment}`,
        });
      }
    }
  });

export const HttpRouteAuthSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("bearer"),
      /** Case-insensitive HTTP authentication schemes accepted before the per-world token. */
      schemes: z.array(z.string().min(1).max(64).regex(HTTP_NAME)).min(1).default(["Bearer"]),
    })
    .strict()
    .superRefine((auth, context) => {
      const normalized = auth.schemes.map((scheme) => scheme.toLowerCase());
      if (new Set(normalized).size !== normalized.length) {
        context.addIssue({ code: "custom", path: ["schemes"], message: "bearer schemes must be unique" });
      }
    }),
  z
    .object({
      kind: z.literal("header"),
      name: z.string().min(1).max(128).regex(HTTP_NAME),
    })
    .strict(),
  z
    .object({
      kind: z.literal("query"),
      name: z.string().min(1).max(128).regex(HTTP_NAME),
    })
    .strict(),
  z
    .object({
      kind: z.literal("basic"),
      token: z.enum(["username", "password"]),
      username: z.string().min(1).max(128).optional(),
    })
    .strict()
    .superRefine((auth, context) => {
      if (auth.token === "password" && auth.username === undefined) {
        context.addIssue({
          code: "custom",
          path: ["username"],
          message: "basic password authentication requires a fixed username",
        });
      }
      if (auth.token === "username" && auth.username !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["username"],
          message: "basic username authentication cannot also declare a fixed username",
        });
      }
    }),
  z.object({ kind: z.literal("none") }).strict(),
]);

export const HttpRouteContractSchema = z
  .object({
    id: StableIdSchema,
    operationId: OperationIdSchema,
    method: HttpMethodSchema,
    path: HttpPathTemplateSchema,
    auth: HttpRouteAuthSchema,
    requestBody: z.enum(["none", "json", "form", "text"]),
    response: z
      .object({
        successStatus: z.number().int().min(200).max(299),
        errors: z
          .array(
            z
              .object({
                code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
                status: z.number().int().min(400).max(599),
              })
              .strict(),
          )
          .default([]),
      })
      .strict(),
  })
  .strict()
  .superRefine((route, context) => {
    if (httpRouteConflictsWithFramework(route)) {
      context.addIssue({
        code: "custom",
        path: ["path"],
        message: `HTTP route conflicts with a framework route at ${route.method} ${route.path}`,
      });
    }
    const seen = new Set<string>();
    for (const [index, error] of route.response.errors.entries()) {
      if (seen.has(error.code)) {
        context.addIssue({
          code: "custom",
          path: ["response", "errors", index, "code"],
          message: `duplicate HTTP error mapping ${error.code}`,
        });
      }
      seen.add(error.code);
    }
  });

export const ToolCompatibilityClientSchema = z
  .object({
    ecosystem: z.enum(["npm", "pypi", "other"]),
    name: z.string().min(1).max(256),
    version: z.string().min(1).max(128),
  })
  .strict()
  .superRefine((client, context) => {
    if (client.ecosystem === "npm" && !NodePackageNameSchema.safeParse(client.name).success) {
      context.addIssue({
        code: "custom",
        path: ["name"],
        message: "npm compatibility clients require a valid package name",
      });
    }
  });

export const ToolCompatibilityRouteSchema = z
  .object({
    routeId: StableIdSchema,
    clientMethod: z.string().min(1).max(256),
  })
  .strict();

export const ToolCompatibilityFlowSchema = z
  .object({
    id: StableIdSchema,
    description: z.string().min(1).max(1000),
    routeIds: z.array(StableIdSchema).min(1),
  })
  .strict()
  .superRefine((flow, context) => {
    if (new Set(flow.routeIds).size !== flow.routeIds.length) {
      context.addIssue({ code: "custom", path: ["routeIds"], message: "flow routes must be unique" });
    }
  });

/** A bounded wire-compatibility claim backed by a pack-owned official-client check. */
export const ToolCompatibilityProfileSchema = z
  .object({
    id: StableIdSchema,
    mode: z.literal("translated"),
    protocol: z.literal("http"),
    service: z.string().min(1).max(256),
    apiVersion: z.string().min(1).max(128).optional(),
    client: ToolCompatibilityClientSchema,
    configuration: z
      .object({
        endpoint: z.string().min(1).max(128),
        credential: z.string().min(1).max(128),
      })
      .strict(),
    routes: z.array(ToolCompatibilityRouteSchema).min(1),
    flows: z.array(ToolCompatibilityFlowSchema).min(1),
    limitations: z.array(z.string().min(1).max(1000)).min(1).max(100),
  })
  .strict()
  .superRefine((profile, context) => {
    for (const [field, values] of [
      ["routes", profile.routes.map((route) => route.routeId)],
      ["flows", profile.flows.map((flow) => flow.id)],
      ["limitations", profile.limitations],
    ] as const) {
      if (new Set(values).size !== values.length) {
        context.addIssue({ code: "custom", path: [field], message: `${field} must not contain duplicates` });
      }
    }
    const routeIds = new Set(profile.routes.map((route) => route.routeId));
    for (const [flowIndex, flow] of profile.flows.entries()) {
      for (const [routeIndex, routeId] of flow.routeIds.entries()) {
        if (!routeIds.has(routeId)) {
          context.addIssue({
            code: "custom",
            path: ["flows", flowIndex, "routeIds", routeIndex],
            message: `flow references uncovered compatibility route ${routeId}`,
          });
        }
      }
    }
  });

const CallbackPathSchema = HttpPathTemplateSchema.refine(
  (path) => httpPathSegments(path).every((segment) => httpPathParameter(segment) === undefined),
  "callback paths must be static; encode dynamic identifiers in the body or headers",
);

export const CallbackSignatureSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z
    .object({
      kind: z.literal("hmac-sha256"),
      header: z.string().min(1).max(128).regex(HTTP_NAME),
      prefix: z.string().max(32).default("sha256="),
    })
    .strict(),
]);

export const CallbackRetryPolicySchema = z
  .object({
    /** One delay per retry; an empty list means one attempt with no retry. */
    delaysUs: z.array(VirtualTimeSchema).max(9).default([]),
  })
  .strict();

export const CallbackContractSchema = z
  .object({
    id: StableIdSchema,
    eventId: EventIdSchema,
    receiverId: StableIdSchema,
    method: z.enum(["POST", "PUT"]),
    path: CallbackPathSchema,
    idempotencyHeader: z.string().min(1).max(128).regex(HTTP_NAME),
    signature: CallbackSignatureSchema.default({ kind: "none" }),
    retry: CallbackRetryPolicySchema.default({ delaysUs: [] }),
    timeoutMs: z.number().int().min(100).max(30_000).default(5_000),
  })
  .strict()
  .superRefine((callback, context) => {
    if (
      callback.signature.kind === "hmac-sha256" &&
      callback.signature.header.toLowerCase() === callback.idempotencyHeader.toLowerCase()
    ) {
      context.addIssue({
        code: "custom",
        path: ["signature", "header"],
        message: "signature and idempotency headers must be different",
      });
    }
  });

export const ToolPackageManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: PackageIdSchema,
    version: SemverSchema,
    engine: z.string().min(1).max(128),
    capabilities: z.array(ToolCapabilitySchema),
    state: z.array(ToolStateContractSchema).default([]),
    operations: z.array(OperationContractSchema).min(1),
    events: z.array(ToolEventContractSchema).default([]),
    faults: z.array(ToolFaultContractSchema).default([]),
    subscriptions: z.array(ToolSubscriptionContractSchema).default([]),
    http: z.array(HttpRouteContractSchema).default([]),
    callbacks: z.array(CallbackContractSchema).default([]),
    compatibility: z.array(ToolCompatibilityProfileSchema).default([]),
  })
  .strict()
  .superRefine((manifest, context) => {
    const seen = new Set<string>();
    for (const [index, operation] of manifest.operations.entries()) {
      if (seen.has(operation.id)) {
        context.addIssue({
          code: "custom",
          path: ["operations", index, "id"],
          message: "duplicate operation id",
        });
      }
      seen.add(operation.id);
    }
    const operationIds = new Set(manifest.operations.map((operation) => operation.id));
    const operationsById = new Map(manifest.operations.map((operation) => [operation.id, operation]));
    for (const [index, fault] of manifest.faults.entries()) {
      for (const operationId of fault.appliesTo) {
        if (!operationIds.has(operationId)) {
          context.addIssue({
            code: "custom",
            path: ["faults", index, "appliesTo"],
            message: `fault references unknown operation ${operationId}`,
          });
        } else if (!operationsById.get(operationId)?.declaredErrors.includes(fault.error.code)) {
          context.addIssue({
            code: "custom",
            path: ["faults", index, "error", "code"],
            message: `fault error ${fault.error.code} is not declared by operation ${operationId}`,
          });
        }
      }
    }
    for (const [field, values] of [
      ["events", manifest.events.map((event) => event.id)],
      ["faults", manifest.faults.map((fault) => fault.id)],
      ["subscriptions", manifest.subscriptions.map((subscription) => subscription.id)],
      ["http", manifest.http.map((route) => route.id)],
      ["callbacks", manifest.callbacks.map((callback) => callback.id)],
      ["compatibility", manifest.compatibility.map((profile) => profile.id)],
    ] as const) {
      if (new Set(values).size !== values.length) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: `${field} must not contain duplicate ids`,
        });
      }
    }
    for (const [field, values] of [
      ["capabilities", manifest.capabilities],
      ["state", manifest.state.map((state) => state.namespace)],
    ] as const) {
      if (new Set(values).size !== values.length) {
        context.addIssue({ code: "custom", path: [field], message: `${field} must not contain duplicates` });
      }
    }
    for (const [routeIndex, route] of manifest.http.entries()) {
      const operation = operationsById.get(route.operationId);
      if (operation === undefined) {
        context.addIssue({
          code: "custom",
          path: ["http", routeIndex, "operationId"],
          message: `HTTP route references unknown operation ${route.operationId}`,
        });
        continue;
      }
      const mapped = new Set(route.response.errors.map((error) => error.code));
      for (const declared of operation.declaredErrors) {
        if (!mapped.has(declared)) {
          context.addIssue({
            code: "custom",
            path: ["http", routeIndex, "response", "errors"],
            message: `HTTP route does not map declared error ${declared}`,
          });
        }
      }
      for (const [errorIndex, error] of route.response.errors.entries()) {
        if (!operation.declaredErrors.includes(error.code)) {
          context.addIssue({
            code: "custom",
            path: ["http", routeIndex, "response", "errors", errorIndex, "code"],
            message: `HTTP route maps undeclared error ${error.code}`,
          });
        }
      }
      for (let otherIndex = 0; otherIndex < routeIndex; otherIndex += 1) {
        const other = manifest.http[otherIndex];
        if (other !== undefined && httpRoutesOverlap(route, other)) {
          context.addIssue({
            code: "custom",
            path: ["http", routeIndex, "path"],
            message: `HTTP route overlaps ${other.method} ${other.path}`,
          });
        }
      }
    }
    const httpRouteIds = new Set(manifest.http.map((route) => route.id));
    for (const [profileIndex, profile] of manifest.compatibility.entries()) {
      for (const [routeIndex, route] of profile.routes.entries()) {
        if (!httpRouteIds.has(route.routeId)) {
          context.addIssue({
            code: "custom",
            path: ["compatibility", profileIndex, "routes", routeIndex, "routeId"],
            message: `compatibility profile references unknown HTTP route ${route.routeId}`,
          });
        }
      }
    }
    const eventIds = new Set(manifest.events.map((event) => event.id));
    for (const [callbackIndex, callback] of manifest.callbacks.entries()) {
      if (!eventIds.has(callback.eventId)) {
        context.addIssue({
          code: "custom",
          path: ["callbacks", callbackIndex, "eventId"],
          message: `callback references unknown event ${callback.eventId}`,
        });
      }
    }
  });

export const OperationInvocationSchema = z
  .object({
    schemaVersion: z.literal(1),
    callId: CallIdSchema,
    correlationId: CorrelationIdSchema,
    operation: OperationRefSchema,
    actorBindingId: ActorBindingIdSchema,
    arguments: JsonObjectSchema,
    idempotencyKey: z.string().min(1).max(255).optional(),
  })
  .strict();

export const OperationOutcomeStatusSchema = z.enum(["ok", "denied", "tool_error", "unsupported", "invalid"]);

export const OperationIdempotencyDispositionSchema = z.enum([
  "not_requested",
  "recorded",
  "replayed",
  "not_recorded",
]);

export const OperationOutcomeSchema = z
  .object({
    status: OperationOutcomeStatusSchema,
    value: JsonValueSchema.optional(),
    error: ErrorEnvelopeSchema.optional(),
  })
  .strict()
  .superRefine((outcome, context) => {
    if (outcome.status === "ok" && outcome.value === undefined) {
      context.addIssue({ code: "custom", path: ["value"], message: "successful operation requires a value" });
    }
    if (outcome.status === "ok" && outcome.error !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["error"],
        message: "successful operation cannot carry an error",
      });
    }
    if (outcome.status !== "ok" && outcome.error === undefined) {
      context.addIssue({
        code: "custom",
        path: ["error"],
        message: "unsuccessful operation requires an error",
      });
    }
    if (outcome.status !== "ok" && outcome.value !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["value"],
        message: "unsuccessful operation cannot carry a value",
      });
    }
  });

export type OperationContract = z.infer<typeof OperationContractSchema>;
export type ToolEventContract = z.infer<typeof ToolEventContractSchema>;
export type ToolStateContract = z.infer<typeof ToolStateContractSchema>;
export type ToolFaultContract = z.infer<typeof ToolFaultContractSchema>;
export type ToolSubscriptionContract = z.infer<typeof ToolSubscriptionContractSchema>;
export type HttpMethod = z.infer<typeof HttpMethodSchema>;
export type HttpPathTemplate = z.infer<typeof HttpPathTemplateSchema>;
export type HttpRouteAuth = z.infer<typeof HttpRouteAuthSchema>;
export type HttpRouteContract = z.infer<typeof HttpRouteContractSchema>;
export type CallbackSignature = z.infer<typeof CallbackSignatureSchema>;
export type CallbackRetryPolicy = z.infer<typeof CallbackRetryPolicySchema>;
export type CallbackContract = z.infer<typeof CallbackContractSchema>;
export type ToolCompatibilityClient = z.infer<typeof ToolCompatibilityClientSchema>;
export type ToolCompatibilityRoute = z.infer<typeof ToolCompatibilityRouteSchema>;
export type ToolCompatibilityFlow = z.infer<typeof ToolCompatibilityFlowSchema>;
export type ToolCompatibilityProfile = z.infer<typeof ToolCompatibilityProfileSchema>;
export type ToolPackageManifest = z.infer<typeof ToolPackageManifestSchema>;
export type OperationInvocation = z.infer<typeof OperationInvocationSchema>;
export type OperationOutcome = z.infer<typeof OperationOutcomeSchema>;
export type OperationIdempotencyDisposition = z.infer<typeof OperationIdempotencyDispositionSchema>;
