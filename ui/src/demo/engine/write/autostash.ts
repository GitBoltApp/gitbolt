// The autostash (journal/autostash.rs, spec #2 §6): only on overlap, `stash push -u`, restored with
// `apply --index`, never without a banner. No Stop or Interrupted reasons: nothing can stop a demo
// write midway, and nothing survives a reload. Not here: the 2C `With` rule (what a move sweeps away
// with a folder), since the demo's moves refuse a folder in the way of a file rather than sweep it.
import { compareBytewise, isBinaryHead, latin1 } from '../read/bytes';
import { mergeBaseOf } from '../read/revs';
import { diffTrees, listFiles, readBlobBytes, type FileEntry } from '../read/trees';
import { readFileState } from './files';
import { loadIndex, stage0Of } from './index';
import { mergeTexts } from './mergeFile';
import { mergeTrees, resultTree } from './mergeTrees';
import { ignoredPath } from './move';
import { readHead } from './refs';
import type { WriteCx } from './run';
import type { WriteWt } from './seam';
import { applyStash, binaryAmong, dropStash, patchEntry, pushInTheWay, pushStash, repositoryInTheWay, stashList } from './stash';
import { dirty } from './status';

/** §6.1's table (`AutostashRule`): `overlap` checkout, fast-forward, Switch and Rewind (only when a
 *  dirty path is touched); `anyTracked` any tracked change, or an untracked one touched; `merged` that
 *  for a merge of the target into HEAD (touched against their merge); `rebased` that for a rebase
 *  (git checks the target out first, so an untracked path HEAD→target changes counts too);
 *  `paths` a snapshot restore over P; `touching` `anyTracked` over given paths (a pick's), an
 *  untracked path colliding with one as a folder counting too. */
export type AutostashRule =
  | { kind: 'overlap' }
  | { kind: 'anyTracked' }
  | { kind: 'merged' }
  | { kind: 'rebased' }
  | { kind: 'paths'; paths: string[] }
  | { kind: 'touching'; paths: string[] };
export interface AutostashSpec {
  rule: AutostashRule;
  /** The commit the worktree moves to. */
  target: string | null;
  /** The message's `<op>`: "checkout feature/x", "undo commit \"x\"". */
  op: string;
  /** What the changes would conflict with, for the warning and the banner. */
  targetName: string | null;
}
export interface AutostashPlan {
  message: string;
  target: string | null;
  /** Paths whose restore is predicted to conflict (§6.2): non-empty asks first. */
  conflicts: string[];
  /** Only these (`paths`); null: the whole worktree. */
  pathspec: string[] | null;
  /** Ignored files among them: `--all`. */
  all: boolean;
}
export interface Stashed {
  /** Its `Journal.kept` id. */
  id: number;
  oid: string;
  message: string;
  label: string;
  target: string | null;
}
export type Applied = { status: 'restored' } | { status: 'refused'; index: boolean; message: string } | { status: 'conflicts'; files: number; binary: boolean } | { status: 'partialRestore' };

/** What the worktree moves to, as a tree: for `merged` and `rebased`, the three-way merge of the
 *  target into HEAD (integrate.rs's `merge_result`, conflict markers included), not the target
 *  itself; the target when there's no merge base. */
async function targetTree(wt: WriteWt, rule: AutostashRule, target: string, head: string): Promise<string> {
  if (rule.kind !== 'merged' && rule.kind !== 'rebased') return target;
  const base = await mergeBaseOf(wt.repo, head, target);
  if (base === null) return target;
  return resultTree(wt.repo, await mergeTrees(wt.repo, base, head, target, { ours: 'HEAD', theirs: target }));
}

/** The overlap's paths whose `apply --index` onto `target` would conflict (precheck::predict_conflicts):
 *  HEAD's file as base, the target's as ours, the worktree's as theirs; then the staged ones whose
 *  HEAD→index change wouldn't apply to the target's entry. In the overlap's order. */
async function predict(wt: WriteWt, head: string, target: string, paths: string[]): Promise<string[]> {
  const [headFiles, targetFiles] = [await listFiles(wt.repo, head), await listFiles(wt.repo, target)];
  const index = stage0Of(await loadIndex(wt));
  const bytes = async (e: FileEntry | undefined) => (e ? readBlobBytes(wt.repo, e.oid) : null);
  const eq = (a: Uint8Array | null, b: Uint8Array | null) => (a === null || b === null ? a === b : a.length === b.length && a.every((x, i) => x === b[i]));
  const out: string[] = [];
  for (const p of paths) {
    const [b, o] = [await bytes(headFiles.get(p)), await bytes(targetFiles.get(p))];
    const t = readFileState(wt, p)?.bytes ?? null;
    let conflict: boolean;
    // The target already has these bytes.
    if (eq(o, t)) conflict = false;
    // `git merge-file` refuses a binary file: counted as a conflict.
    else if (b && o && t) conflict = isBinaryHead(b) || isBinaryHead(o) || isBinaryHead(t) || mergeTexts(latin1(b), latin1(o), latin1(t), 'merge', { ours: '', base: '', theirs: '' }).conflicts > 0;
    // Added, deleted or untracked on one side only: git would refuse or conflict.
    else conflict = true;
    if (conflict) out.push(p);
  }
  // The staged side: git re-applies HEAD→index exactly (`apply --cached`), onto the target's entry.
  for (const p of paths) {
    if (out.includes(p)) continue;
    const h = headFiles.get(p) ?? null;
    const i = index.get(p) ?? null;
    if ((i?.oid ?? null) === (h?.oid ?? null)) continue;
    if ((await patchEntry(wt, h, i && { mode: i.mode, oid: i.oid }, targetFiles.get(p) ?? null)) === null) out.push(p);
  }
  return out.sort((x, y) => paths.indexOf(x) - paths.indexOf(y));
}

export async function planAutostash(wt: WriteWt, spec: AutostashSpec): Promise<AutostashPlan | null> {
  const d = await dirty(wt.repo, wt.root);
  const rule = spec.rule;
  // A clean worktree needs no stash, so no tree diff either.
  if (rule.kind !== 'paths' && d.tracked.size === 0 && d.untracked.size === 0) return null;
  const head = readHead(wt).oid;
  const target = rule.kind !== 'paths' && spec.target !== null && head !== null ? await targetTree(wt, rule, spec.target, head) : null;
  const touched = rule.kind === 'paths' || rule.kind === 'touching' ? new Set(rule.paths) : target !== null && head !== null ? new Set((await diffTrees(wt.repo, head, target)).map((c) => c.path)) : new Set<string>();
  // `touching`: an untracked path where a pick puts a folder (`d` against `d/x`), or under a path
  // where it puts a file (`d/y` against `d`), stops git as surely as one at the path.
  if (rule.kind === 'touching') {
    const given = [...touched];
    const collides = (u: string) => given.some((p) => p.startsWith(`${u}/`) || u.startsWith(`${p}/`));
    for (const u of d.untracked) if (collides(u.replace(/\/+$/, ''))) touched.add(u);
  }
  // `rebased`: git checks the target itself out first.
  const checkoutTouched = rule.kind === 'rebased' && spec.target !== null && head !== null ? new Set((await diffTrees(wt.repo, head, spec.target)).map((c) => c.path)) : new Set<string>();
  let overlap = [...[...d.tracked].sort(compareBytewise), ...[...d.untracked].sort(compareBytewise)].filter((p) => touched.has(p));
  let all = false;
  if (rule.kind === 'paths') {
    const tracked = new Set((await loadIndex(wt)).map((e) => e.path));
    const ignored: string[] = [];
    for (const p of rule.paths) if (!tracked.has(p) && readFileState(wt, p) !== null && (await ignoredPath(wt, p))) ignored.push(p);
    all = ignored.length > 0;
    overlap = [...new Set([...overlap, ...ignored])].sort(compareBytewise);
  }
  const needed = rule.kind === 'overlap' || rule.kind === 'paths' ? overlap.length > 0 : d.tracked.size > 0 || [...d.untracked].some((p) => touched.has(p) || checkoutTouched.has(p));
  if (!needed) return null;
  const conflicts = rule.kind === 'paths' ? overlap : target !== null && head !== null ? await predict(wt, head, target, overlap) : [];
  const pathspec = rule.kind === 'paths' ? overlap : null;
  // C1: the stash's own reset writes HEAD's file over a folder at a dirty tracked path, deleting a
  // repository in it: refused before anything runs.
  const inTheWay = await pushInTheWay(wt, d.tracked, pathspec);
  if (inTheWay.length > 0) throw repositoryInTheWay(inTheWay[0], 'stash');
  return { message: `autostash before ${spec.op}`, target: spec.targetName, conflicts, pathspec, all };
}

const step = (cx: WriteCx, s: 'saving' | 'restoring' | null, message: string) => cx.ctx.emit({ type: 'opStashStep', op: cx.op, step: s, message });

/** Step 5: the kept record first (pending, no oid), then `git stash push`, then the record's oid;
 *  git stored nothing (nothing to save, or it refused first): the record goes. */
export async function saveAutostash(cx: WriteCx, plan: AutostashPlan, label: string): Promise<Stashed | null> {
  const j = cx.journal;
  const id = j.keep({ oid: null, message: plan.message, label, target: plan.target, reason: { status: 'pending' }, createdMs: cx.ctx.clock.nowMs() });
  cx.journalChanged = true;
  step(cx, 'saving', plan.message);
  let s;
  try {
    // Every refusal of pushStash comes before it stores anything.
    s = await pushStash(cx.wt, cx.ident(), plan.message, { untracked: plan.all ? 'all' : 'untracked', paths: plan.pathspec });
  } catch (e) {
    j.kept = j.kept.filter((k) => k.id !== id);
    throw e;
  } finally {
    step(cx, null, plan.message);
    cx.touch('stash');
    cx.command('stash', 'push', plan.all ? '--all' : '--include-untracked', '-m', plan.message, ...(plan.pathspec === null ? [] : ['--pathspec-from-file=-', '--pathspec-file-nul']));
  }
  if (s === null) {
    j.kept = j.kept.filter((k) => k.id !== id);
    return null;
  }
  j.keptById(id)!.oid = s.oid;
  return { id, oid: s.oid, message: plan.message, label, target: plan.target };
}

/** §6.3: `git stash apply [--index] <oid>`. Clean: dropped. Content conflicts: the files land in
 *  Conflicted, and the stash is kept. git refused: nothing changed, kept. An untracked file of the
 *  stash in the way is checked first, whatever else happened: the stash holds its only copy. */
export async function restoreAutostash(cx: WriteCx, oid: string, message: string, withIndex: boolean): Promise<Applied> {
  try {
    return await restoreBody(cx, oid, message, withIndex);
  } catch (e) {
    // The core maps any error of its restore to Refused (never a pending record without a banner).
    return { status: 'refused', index: false, message: (e as { message?: string }).message ?? String(e) };
  }
}

async function restoreBody(cx: WriteCx, oid: string, message: string, withIndex: boolean): Promise<Applied> {
  cx.touch('worktree');
  cx.touch('index');
  cx.command('stash', 'apply', ...(withIndex ? ['--index'] : []), oid);
  step(cx, 'restoring', message);
  let r;
  try {
    r = await applyStash(cx.wt, oid, withIndex);
  } catch (e) {
    return { status: 'refused', index: false, message: (e as { message?: string }).message ?? String(e) };
  } finally {
    step(cx, null, message);
  }
  switch (r.kind) {
    case 'applied': {
      const n = stashList(cx.wt).findIndex((s) => s.oid === oid);
      // Gone from the list: the core's lookup fails before any drop runs, and the apply still counts.
      if (n < 0) return { status: 'restored' };
      step(cx, 'restoring', message);
      // Applied: a stash that won't drop is only a leftover entry, not lost changes.
      try {
        dropStash(cx.wt, oid);
      } catch {
        // It's gone already.
      }
      step(cx, null, message);
      cx.touch('stash');
      cx.command('stash', 'drop', '-q', `stash@{${n}}`);
      return { status: 'restored' };
    }
    case 'indexRefused':
      return { status: 'refused', index: true, message: 'conflicts in index. Try without --index.' };
    case 'refused':
      return r.untracked ? { status: 'partialRestore' } : { status: 'refused', index: false, message: r.error.message };
    case 'conflicts':
      return r.untracked ? { status: 'partialRestore' } : { status: 'conflicts', files: r.paths.length, binary: await binaryAmong(cx.wt, oid, r.paths) };
    case 'partial':
      return { status: 'partialRestore' };
  }
}

/** Step 8: restored, the record goes; otherwise its banner shows, with what happened. */
export function settleAutostash(cx: WriteCx, st: Stashed, a: Applied): void {
  const j = cx.journal;
  cx.journalChanged = true;
  if (a.status === 'restored') {
    j.kept = j.kept.filter((k) => k.id !== st.id);
    return;
  }
  const reason = a.status === 'conflicts' ? { status: 'conflicts' as const, files: a.files, binary: a.binary } : { status: a.status };
  const k = j.keptById(st.id);
  if (k) k.reason = reason;
  // Dismissed while the write ran: a stash still kept gets its banner back.
  else j.keep({ oid: st.oid, message: st.message, label: st.label, target: st.target, reason, createdMs: cx.ctx.clock.nowMs() });
}

/** Step 8 for a merge stopped on conflicts: its autostash waits for Commit or Abort (§13.2). */
export function keepPaused(cx: WriteCx, st: Stashed): void {
  const k = cx.journal.keptById(st.id);
  if (k) k.reason = { status: 'paused' };
  cx.journalChanged = true;
}
