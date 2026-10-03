import type { RebasePlanPayload } from '../api/gen/RebasePlanPayload';

/** A fake 40-hex oid: `c` repeated. */
export const oid = (c: string) => c.repeat(40);

/** Rows e, d, c, b, a (newest first; summaries "E"…, messages "E\n"…); chips x on b and y on d
 * (locked); `topic` onto `main` at base 0…0. Tests of the rebase editor share it. */
export function plan(over: Partial<RebasePlanPayload> = {}): RebasePlanPayload {
  const rows = ['e', 'd', 'c', 'b', 'a'].map((c) => ({ oid: oid(c), summary: c.toUpperCase(), message: `${c.toUpperCase()}\n`, authorName: 'Ada', authorEmail: 'ada@example.com', authorTime: 1, upstream: false }));
  return {
    branch: 'topic', base: 'main', baseOid: oid('0'), baseSummary: 'Base', baseChips: ['main'], rows, merges: 0, behind: 1,
    chips: [{ branch: 'x', at: oid('b'), locked: null }, { branch: 'y', at: oid('d'), locked: 'checked out in /w' }],
    branches: ['main', 'topic', 'x', 'y'], expect: { 'refs/heads/topic': oid('e') }, ...over,
  };
}
