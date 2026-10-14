// The interactive rebase's range (the core's write/irebase/plan.rs): rows newest first with merges
// flattened away (`git log --topo-order --no-merges`), the rows the base already has
// (patch-equivalent: `--cherry-mark`'s `=`), the chips of the branches in range, and the refs the
// write will expect.
import type { PlanChip } from '../../../api/gen/PlanChip';
import type { PlanRow } from '../../../api/gen/PlanRow';
import type { RebasePlanPayload } from '../../../api/gen/RebasePlanPayload';
import { compareBytewise } from '../read/bytes';
import { readCommit } from '../read/commitText';
import { dwimRefName, refsUnder, relation, resolveRefName, revParse } from '../read/revs';
import { fail, type ReadRepo } from '../read/seam';
import { worktreeOf } from '../read/worktrees';
import { samePatches } from './patchId';
import { branchesElsewhere, branchSets, isAncestor, rangeCommits, shortRef } from './range';

/** The editor's ceiling (the core's Ruling 11). */
export const MAX_ROWS = 1000;

export interface Range {
  head: string;
  base: string;
  /** The base's full ref name, when `base` names a ref. */
  baseRef: string | null;
  /** `baseRef`'s own value, unpeeled (an annotated tag: the tag object): what the write's ref check compares. */
  baseRefTarget: string | null;
  baseSummary: string;
  rows: PlanRow[];
  merges: number;
  behind: number;
  chips: PlanChip[];
  baseChips: string[];
  /** Every local branch's tip, short name → oid, sorted bytewise. */
  tips: Map<string, string>;
  /** Branches that can't move: short name → why. */
  locked: Map<string, string>;
}

/** A message's first line as the core reads it (Rust's `lines()`: a CRLF's CR goes, a bare CR stays, leading blank lines don't). */
const summaryOf = (message: string) => {
  const nl = message.indexOf('\n');
  return nl < 0 ? message : message.slice(0, nl).replace(/\r$/, '');
};

/** The core's irebase/plan.rs `read_range`. */
export async function readRange(read: ReadRepo, root: string, branch: string, base: string, max: number): Promise<Range> {
  const full = `refs/heads/${branch}`;
  const tips = new Map((await refsUnder(read, 'refs/heads')).map((h) => [shortRef(h.name), h.oid] as const).sort((a, b) => compareBytewise(a[0], b[0])));
  const head = tips.get(branch) ?? fail('NotFound', `No branch ${branch}`);
  // Any failure is NotFound, `<base>: why` (the core's).
  const baseOid = await revParse(read, base, root).catch((e: { message?: string }) => {
    const said = e.message ?? 'no such commit';
    return fail('NotFound', said.startsWith(`${base}: `) ? said : `${base}: ${said}`);
  });
  const baseSummary = summaryOf((await readCommit(read, baseOid)).rawMessage);
  // gix's find_reference: `HEAD` is the worktree's own; other names dwim to a ref under refs/.
  const baseRef = base === 'HEAD' ? ((await worktreeOf(read, root)).head === null ? null : 'HEAD') : dwimRefName(read, base);
  const baseRefTarget = baseRef === null ? null : baseRef === 'HEAD' ? (await worktreeOf(read, root)).head : await resolveRefName(read, baseRef);
  const all = await rangeCommits(read, head, baseOid);
  const plain = all.filter((c) => c.parents.length < 2);
  if (plain.length > max) fail('InvalidInput', `Over ${max} commits between ${base} and ${branch}: the editor takes up to ${max}`);
  const upstream = await samePatches(read, plain.map((c) => c.oid), (await rangeCommits(read, baseOid, head)).map((c) => c.oid), true);
  const rows: PlanRow[] = [];
  for (const c of plain) {
    const parsed = await readCommit(read, c.oid);
    rows.push({
      oid: c.oid,
      summary: summaryOf(parsed.rawMessage),
      message: parsed.rawMessage,
      authorName: parsed.author.name,
      authorEmail: parsed.author.email,
      authorTime: parsed.author.time,
      upstream: upstream.has(c.oid),
    });
  }
  const [, behind] = await relation(read, head, baseOid);
  const away = new Map([...(await branchesElsewhere(read, root))].map(([b, p]) => [shortRef(b), p] as const));
  // Chips: each branch with a tip in range sits on its row, or (a merge commit) on the newest row
  // that's an ancestor of it; stacked ones first, then merged-in ones, each set bytewise.
  const sets = await branchSets(read, full, head, baseOid);
  const locked = new Map<string, string>();
  const chips: PlanChip[] = [];
  for (const [name, tip, merged] of [...sets.stacked.map(([n, o]) => [n, o, false] as const), ...sets.mergedIn.map(([n, o]) => [n, o, true] as const)]) {
    const b = shortRef(name);
    if (b === branch) continue;
    let at: string | null = null;
    for (const r of rows) {
      if (await isAncestor(read, r.oid, tip)) {
        at = r.oid;
        break;
      }
    }
    if (at === null) continue;
    const where = away.get(b);
    const why = where !== undefined ? `checked out in ${where}` : merged ? 'merged in: it stays where it is' : null;
    if (why !== null) locked.set(b, why);
    chips.push({ branch: b, at, locked: why });
  }
  const baseChips = [...tips].filter(([, o]) => o === baseOid).map(([b]) => b);
  return { head, base: baseOid, baseRef, baseRefTarget, baseSummary, rows, merges: all.length - plain.length, behind, chips, baseChips, tips, locked };
}

/** The core's `rebase_plan`. */
export async function rebasePlan(read: ReadRepo, root: string, branch: string, base: string): Promise<RebasePlanPayload> {
  const r = await readRange(read, root, branch, base, MAX_ROWS);
  const expect = new Map<string, string>([[`refs/heads/${branch}`, r.head]]);
  for (const c of r.chips) expect.set(`refs/heads/${c.branch}`, r.tips.get(c.branch)!);
  if (r.baseRef !== null && r.baseRefTarget !== null) expect.set(r.baseRef, r.baseRefTarget);
  return {
    branch,
    base,
    baseOid: r.base,
    baseSummary: r.baseSummary,
    baseChips: r.baseChips,
    rows: r.rows,
    merges: r.merges,
    behind: r.behind,
    chips: r.chips,
    branches: [...r.tips.keys()],
    // A BTreeMap in the core: its keys in byte order.
    expect: Object.fromEntries([...expect].sort((a, b) => compareBytewise(a[0], b[0]))),
  };
}
