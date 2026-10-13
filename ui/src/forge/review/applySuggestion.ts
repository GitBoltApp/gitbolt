import { api } from '../../api/client';
import type { DiffPosition } from '../../api/gen/DiffPosition';
import type { Expect } from '../../api/gen/Expect';
import type { ForgeKind } from '../../api/gen/ForgeKind';
import type { ForgeMr } from '../../api/gen/ForgeMr';
import type { SaveOutcome } from '../../api/gen/SaveOutcome';
import type { WriteResult } from '../../api/gen/WriteResult';
import { useRuntime } from '../../app/runtime';
import { tabView } from '../../app/tabStores';
import { useWorkingCopy } from '../../diff/workingCopy';
import { openWorktree } from '../../repo/store';
import { useToast } from '../../ui/toastStore';
import { journalKey, useJournal } from '../../undo/store';
import { runWrite, type WriteCtx } from '../../write/client';
import { mrNoun } from '../labels';
import { sourceRemote } from '../mrview/checkout';

/**
 * Apply on a review comment's suggestion (spec 2026-10-08): the suggested lines go into the
 * working copy, as an edit, never a commit or a forge call. Only where it lands as the forge
 * meant it: the MR's source branch checked out in the tab's worktree at the MR's head, and the
 * replaced lines still there, at their place (edits elsewhere in the file are fine).
 */

export const ALREADY_APPLIED = 'Already applied';
export const LINES_CHANGED = 'The lines changed since; apply it by hand';
export const checkOutFirst = (kind: ForgeKind, mr: Pick<ForgeMr, 'sourceBranch'>) => `Check out ${mr.sourceBranch} at the ${mrNoun(kind)}'s head to apply`;
export const saveFirst = (path: string) => `Save your edits to ${path} first`;
export const cantRead = (path: string) => `Can't read ${path} here`;
export const OLDER_VERSION = 'This comment is on an older version of the file';

/** The comment's position is on another version than the MR's head: GitHub's `outdated`, or
 * GitLab's `head_sha` another commit. Its line numbers aren't the head's, so it isn't applied. */
export const olderVersion = (pos: DiffPosition | null | undefined, headSha: string | null): boolean =>
  !!pos && (!!pos.outdated || (!!pos.headSha && pos.headSha !== headSha));

/** The tab's active worktree as the graph knows it: its path, branch (full ref) and HEAD. */
export interface ActiveHead { worktree: string; branch: string | null; head: string | null }

export function activeHead(tabId: string): ActiveHead | null {
  const view = tabView(tabId);
  const rt = useRuntime.getState().tabs[tabId];
  if (!view || !rt?.repo) return null;
  const s = view.store.getState();
  const open = openWorktree(s);
  const worktree = rt.worktree ?? open;
  const wt = s.graph.worktrees.find((w) => w.path === worktree);
  if (wt) return { worktree, branch: wt.branch, head: wt.head };
  return worktree === open ? { worktree, branch: s.graph.head.branch, head: s.graph.head.target } : { worktree, branch: null, head: null };
}

/** Whether `branch` (a full ref) is the MR's source branch here: of its name, or the local branch
 * tracking it on the source project's remote (a fork's `<remote>-<branch>`). */
export function isMrBranch(tabId: string, mr: ForgeMr, branch: string | null): boolean {
  const name = branch?.replace(/^refs\/heads\//, '');
  if (!name || name === branch) return false;
  if (name === mr.sourceBranch) return true;
  const remote = sourceRemote(tabId, mr);
  const upstream = useRuntime.getState().tabs[tabId]?.sidebar?.locals.find((l) => l.name === name)?.upstream;
  return remote !== null && upstream === `refs/remotes/${remote}/${mr.sourceBranch}`;
}

/** Where Apply writes, and what it expects there: HEAD and its branch at the MR's head (the core
 * refuses the write if either moved since). */
export interface ApplyAt { ctx: WriteCtx; expect: Expect }

/** Why Apply can't run against what the tab has checked out, or where it writes. `position`: the
 * comment's, when the thread has one. */
export function applyGate(tabId: string, kind: ForgeKind, mr: ForgeMr, headSha: string | null, path: string, position?: DiffPosition | null): ApplyAt | { reason: string } {
  if (olderVersion(position, headSha)) return { reason: OLDER_VERSION };
  const at = activeHead(tabId);
  const repoId = useRuntime.getState().tabs[tabId]?.repo?.id;
  if (!at || repoId === undefined || !headSha || at.head !== headSha || !isMrBranch(tabId, mr, at.branch)) return { reason: checkOutFirst(kind, mr) };
  const wc = useWorkingCopy.getState().copies[tabId];
  if (wc?.dirty && wc.path === path && wc.worktree === at.worktree) return { reason: saveFirst(path) };
  return { ctx: { tabId, repoId, worktree: at.worktree }, expect: { head: headSha, refs: { [at.branch!]: headSha } } };
}

/** A text's lines and the ending each has ('' for a last line without one). */
function linesOf(text: string): { body: string; eol: string }[] {
  const out: { body: string; eol: string }[] = [];
  let i = 0;
  while (i < text.length) {
    const n = text.indexOf('\n', i);
    if (n === -1) {
      out.push({ body: text.slice(i), eol: '' });
      break;
    }
    const cr = n > i && text[n - 1] === '\r';
    out.push({ body: text.slice(i, cr ? n - 1 : n), eol: cr ? '\r\n' : '\n' });
    i = n + 1;
  }
  return out;
}

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const plain = (lines: readonly string[]) => lines.map((l) => l.replace(/\r$/, ''));

/** Why the suggestion can't go into `text` (the working-copy file) at line `from`, replacing
 * `replaced` with `suggested`; null: it can. `applied`: this file is what applying it wrote.
 * The suggested lines found at `from` say it's in, unless the replaced lines are there too and
 * the suggestion is the shorter (it takes lines off their end: not yet applied); a suggestion
 * that changes nothing is in wherever its lines are. */
export function applyCheck(text: string, from: number, replaced: readonly string[], suggested: readonly string[], applied = false): string | null {
  if (applied) return ALREADY_APPLIED;
  const lines = linesOf(text).map((l) => l.body);
  const at = (n: number) => (from >= 1 ? lines.slice(from - 1, from - 1 + n) : []);
  const want = plain(replaced);
  const hasOld = same(at(want.length), want);
  if (same(want, suggested)) return hasOld ? ALREADY_APPLIED : LINES_CHANGED;
  const hasNew = suggested.length > 0 && same(at(suggested.length), suggested);
  if (hasNew && (!hasOld || suggested.length > want.length)) return ALREADY_APPLIED;
  return hasOld ? null : LINES_CHANGED;
}

/** The bytes (their hash) each apply wrote, by worktree, path, line and suggestion: the file
 * still at that hash has it in, whatever its lines look like (a duplicate line deleted). */
const written = new Map<string, string>();
const writtenKey = (worktree: string, path: string, from: number, suggested: readonly string[]) => [worktree, path, String(from), suggested.join('\n')].join('\u0000');
/** Whether `base` is what applying this suggestion wrote. */
export const wroteIt = (worktree: string, path: string, from: number, suggested: readonly string[], base: string): boolean =>
  written.get(writtenKey(worktree, path, from, suggested)) === base;

/**
 * `text` with its lines `from`..`from + count - 1` replaced by `lines` (none: taken out), in the
 * file's line endings: the new lines take the first replaced line's ending, the last the last
 * one's, so a file without a final newline stays without one. Null when the range isn't there.
 */
export function replaceLines(text: string, from: number, count: number, lines: readonly string[]): string | null {
  const all = linesOf(text);
  const to = from + count - 1;
  if (from < 1 || count < 1 || to > all.length) return null;
  const eol = all[from - 1]!.eol || all.find((l) => l.eol)?.eol || '\n';
  const last = all[to - 1]!.eol;
  const put = lines.map((body, i) => ({ body, eol: i === lines.length - 1 ? last : eol }));
  const out = [...all.slice(0, from - 1), ...put, ...all.slice(to)];
  // The file's last lines taken out: the line now last keeps the file without a final newline.
  if (put.length === 0 && last === '' && out.length > 0) out[out.length - 1] = { ...out[out.length - 1]!, eol: '' };
  return out.map((l) => l.body + l.eol).join('');
}

/** A working-copy file's text and its save base (the bytes' hash). */
export interface WorkingFile { text: string; base: string }

/** The working-copy file at `path` in `ctx`'s worktree: its text and save base, null when it
 * can't be edited as text (gone, binary, too large, a filter's clean form). */
export async function readWorkingFile(ctx: Pick<WriteCtx, 'repoId' | 'worktree'>, path: string): Promise<WorkingFile | null> {
  try {
    const c = await api.diffContents(ctx.repoId, { path, old: { kind: 'absent' }, new: { kind: 'worktree', worktree: ctx.worktree }, force: false });
    const n = c.new;
    return n && !c.tooLarge && !n.binary && n.text !== null && n.hash !== null && !n.filtered ? { text: n.text, base: n.hash } : null;
  } catch {
    return null;
  }
}

/** The toast's Undo: the entry the apply made, undone as the toolbar's Undo when it's still on
 * top, else out of order (the Undo list's way). */
async function undoApply(ctx: WriteCtx, entry: number, label: string, path: string): Promise<void> {
  // Loaded on the click: the Undo feature registers its toolbar buttons and shortcuts on import.
  const { undo, undoFromHistory } = await import('../../undo/feature');
  const top = useJournal.getState().states[journalKey(ctx.repoId, ctx.worktree)]?.undo;
  if (top?.entry === entry) await undo(ctx);
  else await undoFromHistory(ctx, { entry, label, kind: 'save', atMs: Date.now(), touched: [path], blocked: null });
}

/**
 * Applies the suggestion: reads the file again, checks the replaced lines are still at `from`,
 * and writes the file with the suggested lines in (`applySuggestion`, journaled, behind the read's
 * base: a change on disk in between is the write's Stale; HEAD moved, its RefMoved). True once written; a refusal says why
 * in a toast. The WIP lists come back with the write, so the diff and WIP refresh at once.
 */
export async function applySuggestion({ ctx, expect }: ApplyAt, path: string, from: number, replaced: readonly string[], suggested: readonly string[]): Promise<boolean> {
  const file = await readWorkingFile(ctx, path);
  const why = file ? applyCheck(file.text, from, replaced, suggested, wroteIt(ctx.worktree, path, from, suggested, file.base)) : cantRead(path);
  if (why || !file) {
    useToast.getState().show(why ?? cantRead(path));
    return false;
  }
  const text = replaceLines(file.text, from, replaced.length, suggested);
  if (text === null) {
    useToast.getState().show(LINES_CHANGED);
    return false;
  }
  let res: WriteResult<SaveOutcome> | null = null;
  const done = await runWrite(ctx, async () => (res = await api.applySuggestion(ctx.repoId, ctx.worktree, path, text, file.base, expect)));
  const r = res as WriteResult<SaveOutcome> | null;
  if (done === null || !r) return false;
  written.set(writtenKey(ctx.worktree, path, from, suggested), r.outcome.hash);
  const entry = r.journal.undo;
  useToast.getState().show(`Applied the suggestion to ${path}`, entry ? { action: { label: 'Undo', run: () => { void undoApply(ctx, entry.entry, entry.label, path); } } } : undefined);
  return true;
}
