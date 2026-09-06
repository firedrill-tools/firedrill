export function compactId(value: string, length = 12): string {
  return value.length <= length ? value : `${value.slice(0, length)}…`;
}

export function titleFromId(value: string): string {
  const title = value.replaceAll(/[._-]+/g, " ");
  return title.length === 0 ? value : `${title[0]?.toUpperCase() ?? ""}${title.slice(1)}`;
}

export function virtualTime(value: number): string {
  if (value === 0) return "0 μs";
  if (value < 1_000) return `${value} μs`;
  if (value < 1_000_000)
    return `${(value / 1_000).toLocaleString(undefined, { maximumFractionDigits: 2 })} ms`;
  if (value < 60_000_000)
    return `${(value / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 })} s`;
  return `${(value / 60_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 })} min`;
}

export function plural(count: number, singular: string, pluralValue = `${singular}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? singular : pluralValue}`;
}

export function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function evidenceLabel(entry: { readonly kind: string } & Record<string, unknown>): string {
  switch (entry.kind) {
    case "operation": {
      const invocation = entry.invocation as
        | { readonly operation?: { readonly packageId?: string; readonly operationId?: string } }
        | undefined;
      const operation = invocation?.operation;
      return operation?.packageId !== undefined && operation.operationId !== undefined
        ? `${operation.packageId}.${operation.operationId}`
        : "Tool operation";
    }
    case "state_change":
      return `${String(entry.packageId)}.${String(entry.namespace)} · ${String(entry.rowId)}`;
    case "event": {
      const event = entry.event as { readonly packageId?: string; readonly eventId?: string } | undefined;
      return event?.packageId !== undefined && event.eventId !== undefined
        ? `${event.packageId}.${event.eventId}`
        : "World event";
    }
    case "callback": {
      const callback = entry.callback as
        | { readonly packageId?: string; readonly callbackId?: string }
        | undefined;
      return callback?.packageId !== undefined && callback.callbackId !== undefined
        ? `${callback.packageId}.${callback.callbackId}`
        : "Callback delivery";
    }
    case "verification": {
      const result = entry.result as { readonly assertionId?: string } | undefined;
      return result?.assertionId ?? "Assertion";
    }
    case "fault":
      return `${String(entry.packageId)}.${String(entry.faultId)}`;
    case "fault_control":
      return `${String(entry.packageId)}.${String(entry.faultId)} · ${entry.active ? "enabled" : "disabled"}`;
    case "clock":
      return "Virtual clock advanced";
    case "lifecycle":
      return titleFromId(String(entry.action));
    case "random":
      return `${String(entry.packageId)} deterministic draw`;
    default:
      return titleFromId(entry.kind);
  }
}
