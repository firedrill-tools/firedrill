/** Locale-independent order shared by release and registry tooling. */
export function compareStableStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
