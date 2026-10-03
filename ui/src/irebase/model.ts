import type { ChipPlan } from '../api/gen/ChipPlan';
import type { RebasePlanPayload } from '../api/gen/RebasePlanPayload';
import type { RebaseRow } from '../api/gen/RebaseRow';
import type { RebaseRowAction } from '../api/gen/RebaseRowAction';
import { branchNameError } from '../branches/branchName';

/**
 * The interactive rebase editor's state (spec #3 §4.1): rows newest first, as the graph shows
 * them, with their actions and edited messages; the branch chips; the selection; and the opening
 * plan, for Reset. Pure. Its rules are the core's `todo::build` rules (plan 3C T2), so what the
 * editor shows is what the rebase does.
 */
export type RowAction = RebaseRowAction;
export const ACTIONS: readonly RowAction[] = ['pick', 'reword', 'squash', 'fixup', 'drop', 'edit'];
export const ACTION_KEYS: Readonly<Record<string, RowAction>> = { p: 'pick', r: 'reword', s: 'squash', f: 'fixup', d: 'drop', e: 'edit' };
export const ACTION_LABEL: Readonly<Record<RowAction, string>> = { pick: 'Pick', reword: 'Reword', squash: 'Squash', fixup: 'Fixup', drop: 'Drop', edit: 'Edit' };
export const ACTION_TIP: Readonly<Record<RowAction, string>> = {
  pick: 'Keep the commit',
  reword: 'Keep the commit, with a new message',
  squash: 'Squash into the commit below, merging the messages',
  fixup: 'Squash, discard this message',
  drop: 'Leave the commit out',
  edit: 'Stop before committing this commit: its changes are staged and its message is in the commit box, so you can change, split or reword it, then Continue.',
};

export interface EditorRow {
  oid: string;
  summary: string;
  /** The commit's own message. */
  message: string;
  authorName: string;
  authorEmail: string;
  authorTime: number;
  action: RowAction;
  /** The new message (`…\n`); `null`: unchanged. On a fold target, the merged message. */
  edited: string | null;
}

export interface EditorChip {
  branch: string;
  /** The row it was put on (an oid, or the base's). Where git leaves it is `chipRow`. */
  at: string;
  /** Its row when the editor opened; `null`: added here. */
  origin: string | null;
  /** Struck out: deleted once the rebase completes. */
  deleted: boolean;
  /** Why it can't move ("checked out in …"); `null`: free. */
  locked: string | null;
}

export interface EditorState {
  branch: string;
  base: { name: string; oid: string; summary: string; chips: string[] };
  merges: number;
  expect: Record<string, string>;
  /** Every local branch: a new chip's name must be new. */
  branches: string[];
  rows: EditorRow[];
  chips: EditorChip[];
  selected: string[];
  anchor: string | null;
  /** The opening plan (with its preset): Reset and `dirty`. */
  initial: { rows: EditorRow[]; chips: EditorChip[] };
}

export interface Preset {
  rows: Partial<Record<string, RowAction>>;
  /** Moves the preset's Squash and Fixup rows right above this row (keeping their order), so
   * they fold into it ("Squash interactively…"). */
  gather?: string;
}

export interface Grouping {
  /** A Squash or Fixup row's fold target; absent: nothing below to fold into. */
  into: Map<string, string>;
  /** A target's folded rows, oldest first. */
  folded: Map<string, string[]>;
}

/** The core's `norm`: CRLF to LF, trailing whitespace off. */
const norm = (m: string) => m.replace(/\r\n/g, '\n').replace(/\s+$/, '');
const short = (oid: string) => oid.slice(0, 7);
const folds = (a: RowAction) => a === 'squash' || a === 'fixup';

export function fromPlan(plan: RebasePlanPayload, preset?: Preset): EditorState {
  const rows: EditorRow[] = plan.rows.map((r) => ({ oid: r.oid, summary: r.summary, message: r.message, authorName: r.authorName, authorEmail: r.authorEmail, authorTime: r.authorTime, action: 'pick', edited: null }));
  const chips: EditorChip[] = plan.chips.map((c) => ({ branch: c.branch, at: c.at, origin: c.at, deleted: false, locked: c.locked }));
  let s: EditorState = {
    branch: plan.branch, base: { name: plan.base, oid: plan.baseOid, summary: plan.baseSummary, chips: plan.baseChips }, merges: plan.merges,
    expect: plan.expect, branches: plan.branches, rows, chips, selected: [], anchor: null, initial: { rows, chips },
  };
  if (preset) s = applyPreset(s, preset);
  return { ...s, initial: { rows: s.rows, chips: s.chips } };
}

export function applyPreset(s: EditorState, p: Preset): EditorState {
  let rows = s.rows.map((r) => (p.rows[r.oid] ? { ...r, action: p.rows[r.oid]! } : r));
  if (p.gather && rows.some((r) => r.oid === p.gather)) {
    const gathered = (r: EditorRow) => r.oid !== p.gather && !!p.rows[r.oid] && folds(r.action);
    const moved = rows.filter(gathered);
    const rest = rows.filter((r) => !gathered(r));
    const at = rest.findIndex((r) => r.oid === p.gather);
    rows = [...rest.slice(0, at), ...moved, ...rest.slice(at)];
  }
  return { ...s, rows };
}

/** Squash and Fixup fold into the nearest older row that isn't dropped (replay order: oldest first). */
export function grouping(rows: readonly EditorRow[]): Grouping {
  const into = new Map<string, string>();
  const folded = new Map<string, string[]>();
  let target: string | null = null;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.action === 'drop') continue;
    if (folds(r.action)) {
      if (target) {
        into.set(r.oid, target);
        folded.get(target)!.push(r.oid);
      }
      continue;
    }
    target = r.oid;
    folded.set(target, []);
  }
  return { into, folded };
}

/** The core's `merged` (plan 3C T2): non-empty messages, trimmed, blank-line separated, `\n` at the end. */
export function mergedMessage(messages: readonly string[]): string {
  return `${messages.map(norm).filter(Boolean).join('\n\n')}\n`;
}

const byOid = (s: EditorState) => new Map(s.rows.map((r) => [r.oid, r] as const));

/** A row's message as the rebase writes it: its edit; else, on a target with Squash rows
 * folding in, the merged default; else its own. */
export function targetMessage(s: EditorState, oid: string, g: Grouping = grouping(s.rows)): string {
  const rows = byOid(s);
  const t = rows.get(oid)!;
  if (t.edited !== null) return t.edited;
  const squashed = (g.folded.get(oid) ?? []).map((o) => rows.get(o)!).filter((r) => r.action === 'squash');
  return squashed.length ? mergedMessage([t.message, ...squashed.map((r) => r.edited ?? r.message)]) : t.message;
}

/** Where git leaves a chip put on `at`: the first row from there down that isn't dropped (a
 * folded row: its target); the base when nothing below survives. */
export function chipRow(s: EditorState, at: string, g: Grouping = grouping(s.rows)): string {
  let i = s.rows.findIndex((r) => r.oid === at);
  if (i < 0) return s.base.oid;
  for (; i < s.rows.length; i++) {
    const r = s.rows[i];
    if (r.action !== 'drop') return g.into.get(r.oid) ?? r.oid;
  }
  return s.base.oid;
}

/** The rebased branch's row (spec #3 §2): the effective top. `null`: every row dropped. */
export function rebasedRow(s: EditorState, g: Grouping = grouping(s.rows)): string | null {
  const top = s.rows.find((r) => r.action !== 'drop');
  return top ? g.into.get(top.oid) ?? top.oid : null;
}

const withRows = (s: EditorState, rows: EditorRow[]): EditorState => ({ ...s, rows });

export function setActions(s: EditorState, oids: readonly string[], action: RowAction): EditorState {
  const set = new Set(oids);
  return withRows(s, s.rows.map((r) => (set.has(r.oid) && r.action !== action ? { ...r, action } : r)));
}

/** Sets a row's message; one equal to what it would be anyway is no edit. */
export function editMessage(s: EditorState, oid: string, text: string): EditorState {
  const cleared = withRows(s, s.rows.map((r) => (r.oid === oid ? { ...r, edited: null } : r)));
  if (norm(text) === norm(targetMessage(cleared, oid))) return cleared;
  return withRows(s, s.rows.map((r) => (r.oid === oid ? { ...r, edited: `${norm(text)}\n` } : r)));
}

/** Ctrl+↑ (-1) / Ctrl+↓ (+1): each selected row moves a place, unless the place is the edge or
 * another selected row that couldn't move. */
export function moveSelected(s: EditorState, delta: -1 | 1): EditorState {
  const sel = new Set(s.selected);
  const rows = [...s.rows];
  if (delta < 0) {
    for (let i = 1; i < rows.length; i++) if (sel.has(rows[i].oid) && !sel.has(rows[i - 1].oid)) [rows[i - 1], rows[i]] = [rows[i], rows[i - 1]];
  } else {
    for (let i = rows.length - 2; i >= 0; i--) if (sel.has(rows[i].oid) && !sel.has(rows[i + 1].oid)) [rows[i], rows[i + 1]] = [rows[i + 1], rows[i]];
  }
  return withRows(s, rows);
}

/** A drag: the row at `from` lands at `to`. */
export function moveRow(s: EditorState, from: number, to: number): EditorState {
  const n = s.rows.length;
  if (from === to || from < 0 || to < 0 || from >= n || to >= n) return s;
  const rows = [...s.rows];
  const [r] = rows.splice(from, 1);
  rows.splice(to, 0, r);
  return withRows(s, rows);
}

/** A group drag (UX2 E.3): the rows `oids`, in their order, land together at slot `to` of the
 * rows left without them (0: the top); a scattered selection closes up. */
export function moveRows(s: EditorState, oids: readonly string[], to: number): EditorState {
  const set = new Set(oids);
  const group = s.rows.filter((r) => set.has(r.oid));
  if (!group.length) return s;
  const rest = s.rows.filter((r) => !set.has(r.oid));
  const at = Math.max(0, Math.min(rest.length, to));
  const rows = [...rest.slice(0, at), ...group, ...rest.slice(at)];
  return rows.every((r, i) => r === s.rows[i]) ? s : withRows(s, rows);
}

export function select(s: EditorState, oid: string, mods: { shift?: boolean; ctrl?: boolean } = {}): EditorState {
  const a = mods.shift && s.anchor ? s.rows.findIndex((r) => r.oid === s.anchor) : -1;
  const b = s.rows.findIndex((r) => r.oid === oid);
  if (a >= 0 && b >= 0) {
    const range = s.rows.slice(Math.min(a, b), Math.max(a, b) + 1).map((r) => r.oid);
    return { ...s, selected: mods.ctrl ? [...new Set([...s.selected, ...range])] : range };
  }
  if (mods.ctrl) {
    const on = s.selected.includes(oid);
    return { ...s, selected: on ? s.selected.filter((o) => o !== oid) : [...s.selected, oid], anchor: oid };
  }
  return { ...s, selected: [oid], anchor: oid };
}

export function moveChip(s: EditorState, branch: string, oid: string): EditorState {
  return { ...s, chips: s.chips.map((c) => (c.branch === branch && !c.locked ? { ...c, at: oid, deleted: false } : c)) };
}

/** "+" on a row: a new branch there. A string is the reason it can't be added. */
export function addChip(s: EditorState, branch: string, oid: string): EditorState | string {
  const name = branch.trim();
  const bad = branchNameError(name);
  if (bad) return bad;
  if (name === s.branch || s.branches.includes(name) || s.chips.some((c) => c.branch === name)) return `${name} already exists`;
  return { ...s, chips: [...s.chips, { branch: name, at: oid, origin: null, deleted: false, locked: null }] };
}

/** ×: an existing chip is struck out ("will be deleted"), or brought back; an added one goes.
 * A locked chip can't be removed. */
export function removeChip(s: EditorState, branch: string): EditorState {
  const c = s.chips.find((x) => x.branch === branch);
  if (!c || c.locked) return s;
  if (c.origin === null) return { ...s, chips: s.chips.filter((x) => x !== c) };
  return { ...s, chips: s.chips.map((x) => (x === c ? { ...x, deleted: !x.deleted } : x)) };
}

/** The chip menu's "Delete branch": an existing chip is struck out, an added one goes. */
export function deleteChip(s: EditorState, branch: string): EditorState {
  const c = s.chips.find((x) => x.branch === branch);
  if (!c || c.locked || c.deleted) return s;
  return removeChip(s, branch);
}

/** What the plan does to a chip's branch: nothing, a move, an add or a delete. */
export function chipChange(c: EditorChip): 'none' | 'moved' | 'added' | 'deleted' {
  if (c.origin === null) return 'added';
  if (c.deleted) return 'deleted';
  return c.at === c.origin ? 'none' : 'moved';
}

/** The chip menu's "Remove from this plan's changes" / "Restore": the chip as it opened (back
 * on its row, not deleted); an added one goes. */
export function revertChip(s: EditorState, branch: string): EditorState {
  const c = s.chips.find((x) => x.branch === branch);
  if (!c || c.locked || chipChange(c) === 'none') return s;
  if (c.origin === null) return { ...s, chips: s.chips.filter((x) => x !== c) };
  return { ...s, chips: s.chips.map((x) => (x === c ? { ...x, at: c.origin!, deleted: false } : x)) };
}

export const reset = (s: EditorState): EditorState => ({ ...s, rows: s.initial.rows, chips: s.initial.chips, selected: [], anchor: null });

const shape = (rows: readonly EditorRow[], chips: readonly EditorChip[]) =>
  JSON.stringify([rows.map((r) => [r.oid, r.action, r.edited]), chips.map((c) => [c.branch, c.at, c.deleted])]);
export const dirty = (s: EditorState): boolean => shape(s.rows, s.chips) !== shape(s.initial.rows, s.initial.chips);
/** Whether `a` and `b` are the same plan (rows, actions, messages, chips): the selection aside. */
export const samePlan = (a: { rows: readonly EditorRow[]; chips: readonly EditorChip[] }, b: { rows: readonly EditorRow[]; chips: readonly EditorChip[] }): boolean =>
  (a.rows === b.rows && a.chips === b.chips) || shape(a.rows, a.chips) === shape(b.rows, b.chips);

/** What keeps Start disabled, first one shown (the core refuses the same, plan 3C T2). */
export function problems(s: EditorState, g: Grouping = grouping(s.rows)): string[] {
  const out: string[] = [];
  if (s.rows.every((r) => r.action === 'drop')) out.push('Every commit is dropped: keep at least one, or cancel the rebase');
  const rows = byOid(s);
  for (const r of [...s.rows].reverse()) {
    if (folds(r.action) && !g.into.has(r.oid)) out.push(`Nothing below ${short(r.oid)} ${r.summary} to squash it into`);
    const t = g.into.get(r.oid);
    if (t && rows.get(t)?.action === 'edit') out.push(`${short(r.oid)} can't fold into ${short(t)}: an Edit row stops before the commits above it fold in`);
    if (r.edited !== null && !r.edited.trim()) out.push(`Write a message for ${short(r.oid)}`);
  }
  return out;
}

/** The InteractiveRebase request's rows and chips. */
export function toRequest(s: EditorState): { rows: RebaseRow[]; chips: ChipPlan[] } {
  const g = grouping(s.rows);
  const rows = byOid(s);
  const out = s.rows.map((r): RebaseRow => {
    const squashedIn = (g.folded.get(r.oid) ?? []).some((o) => rows.get(o)!.action === 'squash');
    const message = r.action === 'drop' ? null : squashedIn ? targetMessage(s, r.oid, g) : r.edited;
    return message === null ? { oid: r.oid, action: r.action } : { oid: r.oid, action: r.action, message };
  });
  const chips = s.chips.flatMap((c): ChipPlan[] => {
    if (c.locked) return c.origin ? [{ branch: c.branch, at: { kind: 'row', oid: c.origin } }] : [];
    if (c.origin === null) return c.deleted ? [] : [{ branch: c.branch, at: { kind: 'new', oid: chipRow(s, c.at, g) } }];
    return [{ branch: c.branch, at: c.deleted ? { kind: 'delete' } : { kind: 'row', oid: chipRow(s, c.at, g) } }];
  });
  return { rows: out, chips };
}

/**
 * "Reload" after RefMoved (spec #3 §5): the new plan, keeping what it can of `old`.
 * - Each commit still there keeps its action and message.
 * - The commits of both keep `old`'s order among themselves; new ones stay where the plan has them.
 * - Chips keep their moves and deletes, and added ones stay, where their rows still exist.
 */
export function reload(old: EditorState, plan: RebasePlanPayload): EditorState {
  const fresh = fromPlan(plan);
  const was = new Map(old.rows.map((r) => [r.oid, r] as const));
  const kept = old.rows.filter((r) => fresh.rows.some((f) => f.oid === r.oid));
  let k = 0;
  const freshBy = byOid(fresh);
  const rows = fresh.rows.map((f) => {
    if (!was.has(f.oid)) return f;
    const o = kept[k++];
    return { ...freshBy.get(o.oid)!, action: o.action, edited: o.edited };
  });
  const exists = (oid: string) => oid === fresh.base.oid || rows.some((r) => r.oid === oid);
  const chips = fresh.chips.map((c) => {
    const o = old.chips.find((x) => x.branch === c.branch);
    return o && !c.locked && exists(o.at) ? { ...c, at: o.at, deleted: o.deleted } : c;
  });
  const added = old.chips.filter((c) => c.origin === null && exists(c.at) && !fresh.branches.includes(c.branch));
  return { ...fresh, rows, chips: [...chips, ...added] };
}

/** What conflict prediction depends on: order, and which rows apply (messages don't matter). */
export const predictionKey = (s: EditorState): string => s.rows.map((r) => `${r.oid}:${r.action === 'drop' ? 'd' : 'p'}`).join(',');
