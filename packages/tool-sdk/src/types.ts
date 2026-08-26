import type {
  CallbackDeliveryId,
  EventRef,
  HttpMethod,
  JsonObject,
  JsonValue,
  OperationInvocation,
  OperationOutcome,
  OperationRef,
  ToolPackageManifest,
  VirtualTime,
} from "@firedrill/contracts";
import type { ToolFailureOptions } from "./failure.js";

export interface ToolActor {
  readonly id: string;
  readonly attributes: Readonly<JsonObject>;
  readonly grants: readonly OperationRef[];
}

export interface ToolStateRecord {
  readonly rowId: string;
  readonly value: Readonly<JsonObject>;
}

export interface ToolStateScan {
  readonly afterRowId?: string;
  readonly limit?: number;
}

export interface ToolState {
  get(namespace: string, rowId: string): Readonly<JsonObject> | null;
  scan(namespace: string, options?: ToolStateScan): readonly ToolStateRecord[];
  put(namespace: string, rowId: string, value: JsonObject): void;
  delete(namespace: string, rowId: string): boolean;
}

export interface ToolClock {
  nowUs(): number;
}

export interface ToolRandom {
  nextFloat(): number;
  nextInteger(minInclusive: number, maxExclusive: number): number;
  nextU64(): bigint;
}

export interface ToolEvents {
  emit(eventId: string, payload: JsonObject): void;
  scheduleAt(eventId: string, payload: JsonObject, virtualTimeUs: number): void;
}

export type ToolExecutionSource =
  | { readonly kind: "operation"; readonly operationId: string }
  | {
      readonly kind: "subscription";
      readonly subscriptionId: string;
      readonly event: EventRef;
    };

export interface ToolContext {
  readonly packageId: string;
  readonly actor: ToolActor;
  readonly source: ToolExecutionSource;
  /** Stop an operation with one of its declared, expected Tool errors. */
  fail(options: ToolFailureOptions): never;
  readonly state: ToolState;
  readonly clock: ToolClock;
  readonly random: ToolRandom;
  readonly events: ToolEvents;
}

export type ToolOperationHandler = (input: Readonly<JsonObject>, context: ToolContext) => JsonValue;

export type ToolSubscriptionHandler = (payload: Readonly<JsonObject>, context: ToolContext) => void;

export type ToolHttpRequestBody =
  | { readonly kind: "none" }
  | { readonly kind: "json"; readonly value: JsonValue }
  | { readonly kind: "form"; readonly value: Readonly<Record<string, readonly string[]>> }
  | { readonly kind: "text"; readonly value: string };

export interface ToolHttpRequest {
  readonly routeId: string;
  readonly method: HttpMethod;
  readonly pathname: string;
  readonly path: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, readonly string[]>>;
  /** Lowercase header names with all received values retained. */
  readonly headers: Readonly<Record<string, readonly string[]>>;
  readonly body: ToolHttpRequestBody;
}

export interface ToolHttpOperationInput {
  readonly arguments: JsonObject;
  readonly idempotencyKey?: string;
}

export type ToolHttpResponseBody =
  | { readonly kind: "empty" }
  | { readonly kind: "json"; readonly value: JsonValue }
  | { readonly kind: "text"; readonly value: string; readonly contentType?: string }
  | { readonly kind: "bytes"; readonly value: Uint8Array; readonly contentType: string };

export interface ToolHttpResponse {
  readonly headers?: Readonly<Record<string, string>>;
  readonly body: ToolHttpResponseBody;
}

export interface ToolHttpOperationResult {
  readonly invocation: OperationInvocation;
  readonly outcome: OperationOutcome;
}

export interface ToolCallbackEvent {
  readonly callbackId: string;
  readonly deliveryId: CallbackDeliveryId;
  readonly receiverId: string;
  readonly event: EventRef;
  readonly payload: Readonly<JsonObject>;
  readonly virtualTimeUs: VirtualTime;
  readonly attempt: number;
}

export interface ToolCallbackRequest {
  readonly headers?: Readonly<Record<string, string>>;
  readonly body: ToolHttpResponseBody;
}

/** Pure event-to-request codec. Delivery, retries, signatures, and evidence remain framework-owned. */
export interface ToolCallbackCodec {
  encode(event: ToolCallbackEvent): ToolCallbackRequest;
}

/** Pure wire codec around one semantic operation. State and side effects remain in the operation handler. */
export interface ToolHttpRouteCodec {
  decode(request: ToolHttpRequest): ToolHttpOperationInput;
  encode(result: ToolHttpOperationResult): ToolHttpResponse;
}

export interface ToolDefinition {
  readonly manifest: ToolPackageManifest;
  readonly operations: Readonly<Record<string, ToolOperationHandler>>;
  readonly subscriptions: Readonly<Record<string, ToolSubscriptionHandler>>;
  readonly http: Readonly<Record<string, ToolHttpRouteCodec>>;
  readonly callbacks: Readonly<Record<string, ToolCallbackCodec>>;
}

export interface ToolDefinitionInput {
  readonly manifest: unknown;
  readonly operations: Readonly<Record<string, ToolOperationHandler>>;
  readonly subscriptions?: Readonly<Record<string, ToolSubscriptionHandler>>;
  readonly http?: Readonly<Record<string, ToolHttpRouteCodec>>;
  readonly callbacks?: Readonly<Record<string, ToolCallbackCodec>>;
}

/** Executable Tool behavior stored separately from its declarative, compiler-validated manifest. */
export interface ToolBehaviorDefinition {
  readonly operations: Readonly<Record<string, ToolOperationHandler>>;
  readonly subscriptions?: Readonly<Record<string, ToolSubscriptionHandler>>;
  readonly http?: Readonly<Record<string, ToolHttpRouteCodec>>;
  readonly callbacks?: Readonly<Record<string, ToolCallbackCodec>>;
}
