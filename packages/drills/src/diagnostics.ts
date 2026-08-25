const MAX_DIAGNOSTIC_MESSAGE_LENGTH = 500;

/** Keeps local failures useful without allowing terminal control bytes or unbounded output. */
export function boundedDiagnosticMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  const normalized = [...error.message]
    .map((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint < 32 || codePoint === 127) ? " " : character;
    })
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
  if (normalized.length === 0) return fallback;
  const characters = [...normalized];
  return characters.length <= MAX_DIAGNOSTIC_MESSAGE_LENGTH
    ? normalized
    : `${characters.slice(0, MAX_DIAGNOSTIC_MESSAGE_LENGTH - 1).join("")}…`;
}
