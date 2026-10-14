// A hunk or line selection applied to one side of a WIP diff (spec #2 §7.3): the bytes `git apply
// --cached [-R]` of the core's partial patch (write/patch.rs) leaves, computed on the lines. The side
// the patch applies to keeps every line but the picked changes, which are taken; 1b's `hunkPicks`
// (the no-newline tie) keeps a line without a newline from being glued to the next.
import type { StageSelection } from '../../../api/gen/StageSelection';
import type { WipBase } from '../../../api/gen/WipBase';
import type { DiffHunk } from '../read/lineDiff';
import { hunkPicks, selectedLines, type Dir } from '../read/patchSelect';
import { fail } from '../read/seam';
import { baseOf, wipDiff, type WipDiff } from '../read/wipDiff';
import type { WriteWt } from './seam';

export const latin1Bytes = (text: string): Uint8Array => Uint8Array.from(text, (c) => c.charCodeAt(0));

export interface Applied {
  /** The side's lines afterwards, each with its own ending. */
  lines: string[];
  /** Changed lines taken (after the tie). */
  picked: number;
  /** Every changed line of the diff was taken. */
  allPicked: boolean;
}

/** `base`: the side the patch applies to (the old side forward, the new side reverse). Null when nothing was picked. */
export function applySelection(base: string[], hunks: DiffHunk[], sel: StageSelection, dir: Dir): Applied | null {
  const out: string[] = [];
  let at = 0;
  let picked = 0;
  let total = 0;
  let any = false;
  hunks.forEach((h, i) => {
    total += h.lines.filter((l) => l.kind !== 'context').length;
    const picks = hunkPicks(h, i, sel, dir);
    if (!picks) return;
    any = true;
    // An empty range's start is the line before it.
    const start = dir === 'forward' ? (h.oldLines === 0 ? h.oldStart : h.oldStart - 1) : h.newLines === 0 ? h.newStart : h.newStart - 1;
    out.push(...base.slice(at, start));
    at = start;
    h.lines.forEach((l, k) => {
      if (l.kind === 'context') {
        out.push(base[at++]);
        return;
      }
      if (picks[k]) picked++;
      const onBase = dir === 'forward' ? l.kind === 'del' : l.kind === 'add';
      if (onBase) {
        if (!picks[k]) out.push(base[at]);
        at++;
      } else if (picks[k]) out.push(l.text);
    });
  });
  if (!any) return null;
  out.push(...base.slice(at));
  return { lines: out, picked, allPicked: picked === total };
}

/** "a hunk", "2 hunks", "1 line", "3 lines", counted after the tie (patch.rs's `selection_label`). */
export function selectionLabel(hunks: DiffHunk[], sel: StageSelection, dir: Dir): string {
  const { hunks: n, lines } = selectedLines(hunks, sel, dir);
  if (sel.kind === 'hunks') return n === 1 ? 'a hunk' : `${n} hunks`;
  return lines === 1 ? '1 line' : `${lines} lines`;
}

export const staleShown = (path: string): never => fail('Stale', `${path} changed since it was shown`);

/** `stage_patch::checked_diff`: the diff the user's base was shown from, checked on both sides of
 *  reading it; a refusal (binary, symlink, a dirty submodule's `Subproject commit` lines, …) is
 *  InvalidInput with its message. */
export async function checkedDiff(wt: WriteWt, path: string, staged: boolean, base: WipBase): Promise<WipDiff> {
  const matches = (now: WipBase) => (staged ? base.head === now.head && base.index === now.index : base.index === now.index && base.worktree === now.worktree);
  if (!matches(await baseOf(wt.repo, wt.root, path))) staleShown(path);
  const d = await wipDiff(wt.repo, wt.root, path, staged);
  if (!matches(await baseOf(wt.repo, wt.root, path))) staleShown(path);
  if (typeof d === 'string') fail('InvalidInput', d);
  return d;
}
