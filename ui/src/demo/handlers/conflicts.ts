// The merge tool (write/conflict.rs): a conflicted file's stages as segments and panes (the core runs
// `git merge-file --diff3`; here Task 13's merge in diff3 style builds the segments directly), and its
// resolutions, each a staging step of its own (§7.6).
import type { ConflictFilePayload } from '../../api/gen/ConflictFilePayload';
import type { ConflictKind } from '../../api/gen/ConflictKind';
import type { ConflictLabels } from '../../api/gen/ConflictLabels';
import type { Pane } from '../../api/gen/Pane';
import type { Resolution } from '../../api/gen/Resolution';
import type { Segment } from '../../api/gen/Segment';
import type { SubmoduleBehind } from '../../api/gen/SubmoduleBehind';
import type { HandlerTable } from '../transport';
import { gbError } from '../engine/errors';
import { AttrReader, markerSizeOf } from '../engine/read/attributes';
import { blobId, latin1, utf8Bytes } from '../engine/read/bytes';
import { gitSubject, readCommitOrNull } from '../engine/read/commitText';
import { decodeBlob } from '../engine/read/decode';
import { diffLines, splitLines } from '../engine/read/lineDiff';
import { fail } from '../engine/read/seam';
import { MODE_GITLINK, MODE_LINK, readBlobBytes } from '../engine/read/trees';
import { checkRelative, nestedHead, safeJoin } from '../engine/read/worktree';
import { checkoutEntry, readFileState, removeWorktreePath, refuseBeyondLink, repoAt, throughLink } from '../engine/write/files';
import { entryOfFile, loadIndex, saveIndex, withEntry, type IndexEntry } from '../engine/write/index';
import { operationKey, readInProgress } from '../engine/write/inProgress';
import { mergeLines, renderMerge } from '../engine/write/mergeFile';
import { latin1Bytes } from '../engine/write/patchApply';
import { readHead } from '../engine/write/refs';
import { runWrite, type WriteCx, type WriteIntent } from '../engine/write/run';
import { writeTarget, type WriteWt } from '../engine/write/seam';
import { capturePath, restorable, samePathState, type PathState } from '../engine/write/staging';
import { declaredEncoding, encode, loadForSave } from '../engine/write/textFile';
import { NO_EXPECT } from './stage';

type Stages = [IndexEntry | null, IndexEntry | null, IndexEntry | null];

export function conflictKindOf(base: boolean, current: boolean, incoming: boolean): ConflictKind | null {
  if (base && current && incoming) return 'bothModified';
  if (!base && current && incoming) return 'bothAdded';
  if (base && !current && incoming) return 'deletedByUs';
  if (base && current && !incoming) return 'deletedByThem';
  if (!base && current && !incoming) return 'addedByUs';
  if (!base && !current && incoming) return 'addedByThem';
  if (base && !current && !incoming) return 'bothDeleted';
  return null;
}

async function stagesOf(wt: WriteWt, path: string): Promise<Stages> {
  const out: Stages = [null, null, null];
  for (const e of await loadIndex(wt)) if (e.path === path && e.stage >= 1 && e.stage <= 3) out[e.stage - 1] = e;
  return out;
}

const short = (oid: string) => oid.slice(0, 7);

async function labelsOf(wt: WriteWt, pausedTarget: string | null): Promise<ConflictLabels> {
  const state = readInProgress(wt.fs, wt.gitdir);
  const headName = () => readHead(wt).branch ?? 'HEAD';
  // gix's `summary()`: git's `%s`.
  const subject = async (oid: string) => {
    const c = await readCommitOrNull(wt.repo, oid);
    return c === null ? '' : gitSubject(c.rawMessage);
  };
  const named = async (oid: string) => `${short(oid)} ${await subject(oid)}`.trimEnd();
  switch (state?.kind) {
    case 'merge': {
      const first = state.message.split('\n')[0] ?? '';
      const m = /^Merge (?:branch|remote-tracking branch) '([^']*)/.exec(first);
      return { current: headName(), incoming: pausedTarget ?? m?.[1] ?? short(state.mergeHead) };
    }
    case 'rebase':
      return { current: pausedTarget ?? short(state.onto), incoming: state.stoppedAt ? await named(state.stoppedAt) : '' };
    case 'cherryPick':
    case 'revert': {
      const n = state.head ? await named(state.head) : null;
      return { current: headName(), incoming: n === null ? 'Incoming' : state.kind === 'revert' ? `parent of ${n}` : n };
    }
    default:
      return { current: 'Current', incoming: 'Incoming' };
  }
}

/** Each region's place in one side's full text (a line diff of the side as the segments give it). */
function pane(segs: Segment[], current: boolean, full: string): Pane {
  const view: string[] = [];
  const spans: [number, number, number][] = [];
  for (const s of segs) {
    if (s.kind === 'common') view.push(...splitLines(s.text));
    else {
      const lines = current ? s.current : s.incoming;
      spans.push([s.id, view.length, lines.length]);
      view.push(...lines);
    }
  }
  const fullLines = splitLines(full);
  const map: (number | null)[] = new Array(view.length + 1).fill(null);
  let i = 0;
  let j = 0;
  for (const e of diffLines(view, fullLines)) {
    while (i < e.oldStart) map[i++] = j++;
    i = e.oldEnd;
    j = e.newEnd;
  }
  while (i < view.length) map[i++] = j++;
  const regions = spans.map(([id, start, lines]) => {
    const at = lines > 0 ? map[start] : null;
    const mapped = at ?? map.slice(start + lines).find((x): x is number => x !== null) ?? fullLines.length;
    return { id, start: mapped + 1, lines };
  });
  return { text: full, regions };
}

async function conflictFile(wt: WriteWt, path: string, pausedTarget: string | null): Promise<ConflictFilePayload | null> {
  const stages = await stagesOf(wt, path);
  const kind = conflictKindOf(stages[0] !== null, stages[1] !== null, stages[2] !== null);
  if (kind === null) return null;
  const labels = await labelsOf(wt, pausedTarget);
  // The file as the core reads it (a final symlink followed), never behind a symlinked folder.
  let onDisk: Uint8Array | null = null;
  if (!throughLink(wt, path)) {
    try {
      onDisk = wt.fs.readFileSync(`${wt.root}/${path}`) as Uint8Array;
    } catch {
      onDisk = null;
    }
  }
  const disk = onDisk === null ? null : decodeBlob(onDisk, null);
  const [encoding, eol] = disk && !disk.binary ? [disk.encoding, disk.eol] : ['UTF-8', 'lf' as const];
  const base = onDisk === null ? null : await blobId(onDisk);
  const none: ConflictFilePayload = { path, kind, text: false, segments: [], current: null, incoming: null, labels, encoding, eol, base };
  // A submodule's commit isn't in this repository: present, with no text.
  if (stages.some((s) => s?.mode === MODE_GITLINK)) return none;
  const text = async (s: IndexEntry | null) => {
    if (s === null) return null;
    const d = decodeBlob(await readBlobBytes(wt.repo, s.oid), null);
    return d.binary ? null : d.text;
  };
  const [cur, inc] = [await text(stages[1]), await text(stages[2])];
  // A binary base next to text sides can't be merged as text either.
  const baseText = stages[0] === null ? '' : await text(stages[0]);
  if (cur === null || inc === null || baseText === null) return none;
  let id = 0;
  const segments: Segment[] = mergeLines(splitLines(baseText), splitLines(cur), splitLines(inc), 'diff3').map((c) =>
    c.kind === 'common' ? { kind: 'common', text: c.lines.join('') } : { kind: 'conflict', id: id++, base: c.base, current: c.ours, incoming: c.theirs },
  );
  return { path, kind, text: true, segments, current: pane(segments, true, cur), incoming: pane(segments, false, inc), labels, encoding, eol, base };
}

/** git's markers of `size`, all three kinds, at line starts. */
function hasMarkers(text: string, size: number): boolean {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  const is = (c: string, labelled: boolean) => lines.some((l) => l.startsWith(c.repeat(size)) && (l.length === size || (labelled && l[size] === ' ')));
  return is('<', true) && is('=', false) && is('>', true);
}

async function markerSize(wt: WriteWt, path: string): Promise<number> {
  return markerSizeOf(new AttrReader(wt.repo, wt.root), path);
}

/** The blob id of the file git left for this conflict; null when it can't be told (a submodule). */
async function gitLeftId(wt: WriteWt, stages: Stages, text: string | null, size: number): Promise<string | null> {
  if (stages.some((s) => s?.mode === MODE_GITLINK)) return null;
  const [b, c, i] = stages;
  if (c === null || i === null) return (c ?? i)?.oid ?? null;
  const blobs = [b ? await readBlobBytes(wt.repo, b.oid) : new Uint8Array(), await readBlobBytes(wt.repo, c.oid), await readBlobBytes(wt.repo, i.oid)];
  if (blobs.some((x) => x.subarray(0, 8000).includes(0))) return c.oid;
  // The core hands git the labels as UTF-8; the merge here is of Latin-1 strings.
  const label = (ch: string) => {
    const l = text?.split('\n').map((x) => x.replace(/\r$/, '')).find((x) => x.startsWith(`${ch.repeat(size)} `))?.slice(size + 1);
    return l === undefined ? null : latin1(utf8Bytes(l));
  };
  const baseLabel = label('|');
  const style = baseLabel === null ? 'merge' : 'diff3';
  const [bl, cl, il] = blobs.map((x) => splitLines(latin1(x)));
  // No `merge.conflictStyle` (zdiff3) in the demo: diff3 markers in the file mean diff3.
  const merged = renderMerge(mergeLines(bl, cl, il, style), style, { ours: label('<') ?? '', base: baseLabel ?? '', theirs: label('>') ?? '' }, size);
  return blobId(latin1Bytes(merged));
}

/** Whether taking a side or deleting would throw away the user's own edits. The core compares
 *  `hash-object --path`; the raw bytes are equal while nothing applies working-tree-encoding/autocrlf on checkout. */
async function handEdited(wt: WriteWt, path: string, stages: Stages, base: string | null): Promise<boolean> {
  const f = readFileState(wt, path);
  if (f === null || f.mode === MODE_LINK) return false;
  const id = await blobId(f.bytes);
  if (base !== null && base !== id) return true;
  const d = decodeBlob(f.bytes, await declaredEncoding(wt, path));
  const expected = await gitLeftId(wt, stages, d.binary ? null : d.text, await markerSize(wt, path));
  return expected === null || expected !== id;
}

const UNDO_LABEL: Record<Resolution['kind'], (p: string) => string> = {
  text: (p) => `resolve ${p}`,
  current: (p) => `resolve ${p} with current`,
  incoming: (p) => `resolve ${p} with incoming`,
  delete: (p) => `resolve ${p} by deleting it`,
  asIs: (p) => `mark ${p} resolved`,
};

function resolveFile(path: string, resolution: Resolution, base: string | null, confirmMarkers: boolean, confirmDiscard: boolean): WriteIntent<SubmoduleBehind | null> {
  // C1: a checkout or a removal where a repository stands would delete it, `.git` and all.
  const repoInTheWay = (wt: WriteWt) => {
    if (repoAt(wt, path)) fail('InvalidInput', `${path} is a repository in the way: move it first`);
  };
  const askFirst = async (wt: WriteWt, stages: Stages) => {
    if (!confirmDiscard && (await handEdited(wt, path, stages, base))) throw { ...gbError('Conflict', `Discard your edits to ${path}?`), detail: { kind: 'discardEdits', path } };
  };
  const stageFile = async (wt: WriteWt) => {
    refuseBeyondLink(wt, path);
    const e = await entryOfFile(wt, path);
    await saveIndex(wt, withEntry(await loadIndex(wt), path, e));
  };
  const act = async (cx: WriteCx, stages: Stages): Promise<SubmoduleBehind | null> => {
    const wt = cx.wt;
    const gitlink = stages.some((s) => s?.mode === MODE_GITLINK);
    // Out of the index only (every stage); a submodule's folder stays as it is.
    const unlink = async () => {
      await saveIndex(wt, withEntry(await loadIndex(wt), path, null));
      cx.command('update-index', '--force-remove', '--', path);
    };
    let behind: SubmoduleBehind | null = null;
    switch (resolution.kind) {
      case 'text': {
        const loaded = await loadForSave(wt, path, base, 'resolve');
        const bytes = encode(resolution.text, loaded.decoded.encoding, loaded.decoded.eol === 'crlf' ? 'crlf' : 'none', loaded.bom);
        // `write_atomic`: the file's own permissions kept.
        wt.fs.writeFileSync(await safeJoin(wt.repo, wt.root, path), bytes);
        cx.touch('worktree');
        await stageFile(wt);
        cx.command('add', '--', path);
        break;
      }
      case 'current':
      case 'incoming': {
        const side = stages[resolution.kind === 'current' ? 1 : 2];
        if (side?.mode === MODE_GITLINK) {
          await saveIndex(wt, withEntry(await loadIndex(wt), path, { path, mode: MODE_GITLINK, oid: side.oid, stage: 0 }));
          cx.command('update-index', '--cacheinfo', '160000', side.oid, path);
          const head = await nestedHead(wt.repo, wt.root, path);
          if (head !== null && head !== side.oid) behind = { path, head, taken: side.oid };
        } else if (side === null && gitlink) await unlink();
        else {
          repoInTheWay(wt);
          await askFirst(wt, stages);
          if (side !== null) {
            await checkoutEntry(wt, path, side);
            cx.command('checkout', resolution.kind === 'current' ? '--ours' : '--theirs', '--', path);
            await stageFile(wt);
            cx.command('add', '--', path);
          } else {
            // That side deleted the file.
            removeWorktreePath(wt, path);
            await saveIndex(wt, withEntry(await loadIndex(wt), path, null));
            cx.command('rm', '-q', '--', path);
          }
        }
        break;
      }
      case 'delete':
        if (gitlink) await unlink();
        else {
          repoInTheWay(wt);
          // Review M-e: a Delete loses hand edits as surely as a Take.
          await askFirst(wt, stages);
          removeWorktreePath(wt, path);
          await saveIndex(wt, withEntry(await loadIndex(wt), path, null));
          cx.command('rm', '-q', '--', path);
        }
        break;
      case 'asIs': {
        // Only a regular file's text is checked (the core's `disk_text`).
        const f = readFileState(wt, path);
        if (f !== null && f.mode !== MODE_LINK && !confirmMarkers) {
          const d = decodeBlob(f.bytes, await declaredEncoding(wt, path));
          if (!d.binary && d.text !== null && hasMarkers(d.text, await markerSize(wt, path))) throw { ...gbError('Conflict', `${path} still has conflict markers`), detail: { kind: 'markersRemain', path } };
        }
        await stageFile(wt);
        cx.command('add', '--', path);
        break;
      }
    }
    cx.touch('index');
    cx.touch('worktree');
    return behind;
  };
  return {
    kind: 'resolve',
    label: () => `resolve ${path}`,
    class: 'immediate',
    undo: () => null,
    allowedInProgress: true,
    staging: 'own',
    run: async (cx) => {
      const wt = cx.wt;
      const stages = await stagesOf(wt, path);
      if (stages.every((s) => s === null)) throw gbError('Stale', `${path} isn't conflicted anymore`);
      const before: PathState = await capturePath(wt, path);
      const behind = await act(cx, stages);
      const after = await capturePath(wt, path);
      const log = cx.ctx.writes.staging(wt.root);
      log.keepResolves();
      const conflicted = before.entries.some((e) => e.stage !== 0);
      if (conflicted && !samePathState(before, after) && restorable(before, after)) {
        log.record({ label: UNDO_LABEL[resolution.kind](path), head: cx.before.head.oid, change: { kind: 'resolve', path, before, after, op: operationKey(wt.fs, wt.gitdir) } });
      } else log.redo = [];
      return behind;
    },
  };
}

export const conflictHandlers: Pick<HandlerTable, 'conflictFile' | 'resolveFile'> = {
  conflictFile: async ({ repo, worktree, path }, ctx) => {
    checkRelative(path);
    const wt = await writeTarget(ctx, repo, worktree);
    return conflictFile(wt, path, ctx.writes.journal(wt.root).paused()?.paused?.target ?? null);
  },
  resolveFile: async ({ repo, worktree, path, resolution, base, confirmMarkers, confirmDiscard }, ctx) => {
    checkRelative(path);
    return runWrite(ctx, repo, worktree, NO_EXPECT, resolveFile(path, resolution, base ?? null, confirmMarkers === true, confirmDiscard === true));
  },
};
