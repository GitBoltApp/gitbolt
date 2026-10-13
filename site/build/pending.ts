// The demo's methods still answering "Not in the demo" until their plan lands: the PENDING list in
// ui/src/demo/coverage.ts. A screenshot scene that needs one is skipped, naming it.
export function pendingMethods(coverageTs: string): Set<string> {
  const list = /export const PENDING = \[([\s\S]*?)\] as const/.exec(coverageTs)?.[1];
  if (list === undefined) return new Set();
  return new Set([...list.matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]));
}
