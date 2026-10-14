// The interactive rebase's todo (the core's write/irebase/todo.rs `build`), as the sequencer's
// steps: groups (a Pick, Reword or Edit row and the Squash/Fixup rows that fold into it), a group's
// new message on its guarded exec line, and the chips' update-ref steps after their group. Every
// line git's todo has is a step, so `step` and `total` count as git's; a dropped row is a comment
// line, which git doesn't count.
import type { ChipPlan } from '../../../api/gen/ChipPlan';
import type { RebaseRowAction } from '../../../api/gen/RebaseRowAction';
import { trimEndRust, trimRust } from '../objects';
import { compareBytewise } from '../read/bytes';
import { fail } from '../read/seam';
import { branchNameError } from '../writeSeam';
import { shortOid as short } from './range';
import { mergedMessage, type Step } from './state';

/** One row as the intent hands it over: the request's row, plus what the commit says: its own
 *  message, and its `%ae %at %s` (the exec's guard). */
export interface PlannedRow { oid: string; action: RebaseRowAction; message?: string; original: string; guard: string }
export interface TodoPlan {
  /** The rebased branch (short): it moves at the finish, so its chip gets no step. */
  branch: string;
  /** The base's oid: a chip there gets its update-ref before the first pick. */
  base: string;
  /** Newest first, as the editor shows them. */
  rows: PlannedRow[];
  chips: ChipPlan[];
  /** Every local branch's tip (short → oid). */
  tips: Map<string, string>;
  /** Branches that can't move (short → why). */
  locked: Map<string, string>;
}
/** `updateRefs`: branches (short) the update-ref steps move or create, in todo order; `deletes`:
 *  branches (short) deleted once the rebase completes. */
export interface Todo { steps: Step[]; updateRefs: string[]; deletes: string[] }

/** Rust's `lines().next().trim()`. */
const subject = (m: string) => trimRust((m.split('\n')[0] ?? '').replace(/\r$/, ''));
const norm = (m: string) => trimEndRust(m.replaceAll('\r\n', '\n'));
const invalid = (m: string): never => fail('InvalidInput', m);

/** The rows from one target up to the next: the target, then the rows that fold into it. */
interface Group { target: number; folded: number[] }

export function buildTodo(plan: TodoPlan): Todo {
  const seen = new Set<string>();
  for (const r of plan.rows) {
    if (seen.has(r.oid)) invalid(`${short(r.oid)} is in the plan twice`);
    seen.add(r.oid);
  }
  const replay = [...plan.rows].reverse();
  const groups: Group[] = [];
  // Each row's group, for the chips (null: before the first pick).
  const owner = new Map<string, number | null>();
  replay.forEach((r, i) => {
    if (r.action === 'squash' || r.action === 'fixup') {
      const g = groups.at(-1) ?? invalid(`Nothing below ${short(r.oid)} ${subject(r.original)} to squash it into`);
      const target = replay[g.target];
      if (target.action === 'edit') invalid(`${short(r.oid)} can't fold into ${short(target.oid)}: an Edit row stops before the commits above it fold in`);
      g.folded.push(i);
    } else if (r.action !== 'drop') groups.push({ target: i, folded: [] });
    owner.set(r.oid, groups.length > 0 ? groups.length - 1 : null);
  });
  if (groups.length === 0) invalid('Every commit is dropped: keep at least one, or cancel the rebase');

  // Chips: where each update-ref goes.
  const at = new Map<number | null, string[]>();
  const deletes: string[] = [];
  const named = new Set<string>();
  const top = groups.length - 1;
  const put = (p: number | null, b: string) => at.set(p, [...(at.get(p) ?? []), b]);
  for (const c of plan.chips) {
    if (named.has(c.branch)) invalid(`${c.branch} has two chips`);
    named.add(c.branch);
    const place = (oid: string): number | null => {
      if (oid === plan.base) return null;
      if (!owner.has(oid)) invalid(`${c.branch}: ${short(oid)} isn't one of the rebased commits`);
      return owner.get(oid)!;
    };
    // The rebased branch stays on the last group's commit (the finish moves it); anywhere else is
    // refused rather than ignored.
    if (c.branch === plan.branch) {
      if (c.at.kind === 'row' && place(c.at.oid) === top) continue;
      invalid(`${c.branch} is the rebased branch: it stays on the top commit`);
    }
    const tip = plan.tips.get(c.branch);
    // Stay: no step, never moved, locked or not.
    if (c.at.kind === 'stay') {
      if (tip === undefined) invalid(`${c.branch} doesn't exist`);
      continue;
    }
    const why = plan.locked.get(c.branch);
    if (why !== undefined) {
      if (c.at.kind === 'row' && c.at.oid === tip) continue;
      invalid(`${c.branch} can't move: ${why}`);
    }
    switch (c.at.kind) {
      case 'delete':
        if (tip === undefined) invalid(`${c.branch} doesn't exist`);
        deletes.push(c.branch);
        break;
      case 'row':
        if (tip === undefined) invalid(`${c.branch} doesn't exist`);
        put(place(c.at.oid), c.branch);
        break;
      case 'new':
        if (tip !== undefined) invalid(`${c.branch} already exists`);
        if (branchNameError(c.branch) !== null) invalid(`"${c.branch}" isn't a valid branch name`);
        put(place(c.at.oid), c.branch);
        break;
    }
  }

  const steps: Step[] = [];
  const updateRefs: string[] = [];
  const refsAt = (p: number | null) => {
    for (const b of [...(at.get(p) ?? [])].sort(compareBytewise)) {
      steps.push({ op: 'updateRef', ref: `refs/heads/${b}` });
      updateRefs.push(b);
    }
  };
  refsAt(null);
  let n = 0;
  groups.forEach((g, k) => {
    const t = replay[g.target];
    const folds = g.folded.map((i) => replay[i]);
    const messages = [t.original, ...folds.filter((r) => r.action === 'squash').map((r) => r.message ?? r.original)];
    const wanted = t.message !== undefined ? t.message : messages.length > 1 ? mergedMessage(messages) : undefined;
    let message: string | undefined;
    if (wanted !== undefined && norm(wanted) !== norm(t.original)) {
      if (trimRust(wanted) === '') invalid(`Write a message for ${short(t.oid)}`);
      message = `${norm(wanted)}\n`;
    }
    if (message !== undefined) n += 1;
    // An Edit row's message is its stop's. Any other group's goes in at its exec line, which amends
    // HEAD only while it's still the group's commit (the core's guarded script: HEAD's author email,
    // author time and subject are the target's), so a skipped target or a message typed at a stop
    // isn't overwritten.
    const edit = t.action === 'edit';
    steps.push({ op: 'pick', oid: t.oid, parent: null, ...(edit ? { edit: true } : {}), ...(edit && message !== undefined ? { message } : {}) });
    for (const r of folds) steps.push({ op: 'fold', oid: r.oid, fixup: true });
    if (message !== undefined && !edit) steps.push({ op: 'line', text: `exec sh ${n}.sh`, amend: { message, guard: t.guard } });
    refsAt(k);
  });
  return { steps, updateRefs, deletes };
}
