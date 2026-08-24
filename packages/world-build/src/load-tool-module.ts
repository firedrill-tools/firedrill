/** The sole audited dynamic-import boundary for immutable, hash-verified Tool artifacts. */
export async function loadToolModule(url: string): Promise<Record<string, unknown>> {
  return import(url) as Promise<Record<string, unknown>>;
}
