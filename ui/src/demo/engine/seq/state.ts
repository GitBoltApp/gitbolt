// The sequencer's state (plan 4): one JSON file beside the worktree's own git dir, never git's
// `rebase-merge/` or `sequencer/` (nothing in the demo reads those), and what the UI reads of it:
// the `InProgress` the core makes of git's files (in_progress.rs `read`), field for field.
import type { InProgress } from '../../../api/gen/InProgress';
import type { MemFs } from '../memfs';
import { trimEndRust } from '../objects';
import { demoOf, fail, readTextOrNull, type ReadRepo } from '../read/seam';
import { conflicted, indexEntries, withConflicts } from '../writeSeam';

export type SeqKind = 'rebase' | 'cherryPick' | 'revert';
export type Step =
  | { op: 'pick'; oid: string; parent: string | null; message?: string; edit?: boolean }
  | { op: 'fold'; oid: string; fixup: boolean; message?: string }
  | { op: 'merge'; oid: string; parents: string[] }
  | { op: 'updateRef'; ref: string }
  /** A todo line the demo has no work for (git's `label` and `reset` under `--rebase-merges`),
   *  carried so `step` and `total` count as git's; or the core's guarded `exec` after a reworded or
   *  squashed group, which amends its message in (`amend`). */
  | { op: 'line'; text: string; amend?: Amend };

/** The core's reword script: HEAD's message becomes `message` (`git commit --amend --only`), only
 *  while HEAD's `%ae %at %s` is still `guard`. */
export interface Amend { message: string; guard: string }

export interface Stop {
  /** `refused`: git refused the step before it changed anything (an untracked file in its way):
   *  it's rescheduled, and Continue or Skip retries it; or the finish couldn't move a chip. */
  reason: 'conflict' | 'edit' | 'empty' | 'refused';
  /** The commit being applied (REBASE_HEAD / CHERRY_PICK_HEAD / REVERT_HEAD); empty at a refused
   *  finish, where git names none. */
  at: string;
  /** What Continue commits with, line endings normalised. */
  message: string;
  /** Edit stop: the commit made there (`editStop`), its parent (HEAD now) and the paths it adds. */
  made?: string;
  editBase?: string;
  added?: string[];
  /** Empty-pick or refused stop: git's message for it. */
  error?: string;
  /** A merge step's stop: the merge's new parents. */
  parents?: string[];
  /** Edit stop: the made commit's files (path, blob, mode), to tell whether the index changed since. */
  madeFiles?: [string, string, number][];
  /** A pick's conflict stop: the paths conflicted when it stopped (bytewise), which git's message
   *  file lists under `# Conflicts:` however many are resolved since. */
  conflicts?: string[];
  /** An interactive rebase's stop: what the step left there (a staged path's index, a conflicted
   *  path's worktree file, as `<kind> <oid>` or null), which its Abort doesn't keep (UX N). */
  left?: [string, string | null][];
}

export interface SeqState {
  version: 1;
  kind: SeqKind;
  /** The branch being moved (full), or null (a pick on a detached HEAD is refused earlier, so null only for none). */
  headName: string | null;
  origHead: string;
  onto: string;
  /** As the request named it, for the banner and Pause.target. */
  target: string;
  interactive: boolean;
  todo: Step[];
  done: Step[];
  total: number;
  /** The tip the steps build on (detached HEAD during a rebase; the branch's tip during a pick). */
  head: string;
  map: Record<string, string>;
  /** Commits of the range: a step's parent outside it goes onto `onto`. */
  range: string[];
  /** update-ref steps' results, applied at finish: full ref → new tip; with each ref's value at start. */
  refsAfter: Record<string, string>;
  refsBefore: Record<string, string | null>;
  /** Branches deleted at finish (chips marked delete): full ref → tip at start. */
  deletes: Record<string, string>;
  empty: 'drop' | 'stop';
  stop: Stop | null;
  /** The commits picked (a pick or revert sequence's own; settle counts them). */
  picked: string[];
  /** An interactive rebase's last stop note (`Stop.left`) and its key, the last done step. */
  noted?: { key: string; left: [string, string | null][] };
}

export const SEQ_FILE = 'gitvolt-demo-seq.json';

const fileOf = (gitdir: string) => `${gitdir}/${SEQ_FILE}`;

export async function readSeq(read: ReadRepo, gitdir: string): Promise<SeqState | null> {
  const text = await readTextOrNull(read, fileOf(gitdir));
  if (text === null) return null;
  const s = JSON.parse(text) as SeqState;
  if (s.version !== 1) fail('Other', `${SEQ_FILE} has version ${String(s.version)}`);
  return s;
}

export async function writeSeq(read: ReadRepo, gitdir: string, s: SeqState): Promise<void> {
  demoOf(read).fs.writeFileSync(fileOf(gitdir), JSON.stringify(s));
}

export async function clearSeq(read: ReadRepo, gitdir: string): Promise<void> {
  const fs = demoOf(read).fs;
  if (fs.existsSync(fileOf(gitdir), false)) fs.unlinkSync(fileOf(gitdir));
}

export const inProgressWord = (k: SeqKind): 'rebase' | 'cherry-pick' | 'revert' => (k === 'rebase' ? 'rebase' : k === 'cherryPick' ? 'cherry-pick' : 'revert');

/** §8.2: `\r\n` and `\r` become `\n`. */
const normalise = (m: string) => m.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

/** The core's `todo::merged`: each message's CRLFs made LFs and its end trimmed (Rust's
 *  whitespace), the empty ones left out. */
export function mergedMessage(messages: string[]): string {
  const parts = messages.map((m) => trimEndRust(m.replaceAll('\r\n', '\n'))).filter((m) => m !== '');
  return `${parts.join('\n\n')}\n`;
}

function readSync(fs: MemFs, gitdir: string): SeqState | null {
  try {
    return JSON.parse(fs.readFileSync(fileOf(gitdir), 'utf8') as string) as SeqState;
  } catch {
    return null;
  }
}

/** git's state as gix reads it: a rebase from its start to its end (`rebase-merge/`), a pick or a
 *  revert only while stopped (CHERRY_PICK_HEAD, REVERT_HEAD: `sequencer/` alone is none). */
const live = (s: SeqState | null): s is SeqState => s !== null && (s.kind === 'rebase' || s.stop !== null);

export function seqOpName(fs: MemFs, gitdir: string): 'rebase' | 'cherry-pick' | 'revert' | null {
  const s = readSync(fs, gitdir);
  return live(s) ? inProgressWord(s.kind) : null;
}

/** The stop shows HEAD's message (the caller reads it for `seqInProgress`): a conflict at a fold,
 *  where git's `rebase-merge/amend` names HEAD, the commit the fold amends. */
export function seqShowsHeadMessage(fs: MemFs, gitdir: string): boolean {
  const s = readSync(fs, gitdir);
  return s !== null && s.kind === 'rebase' && atFold(s);
}

const atFold = (s: SeqState) => s.stop?.reason === 'conflict' && s.done.at(-1)?.op === 'fold';

/** The core's `index_differs`: the index (stages included) isn't the made commit's tree. */
function indexDiffers(fs: MemFs, gitdir: string, made: [string, string, number][] | undefined): boolean {
  const index = indexEntries(fs, gitdir);
  if (index === null || made === undefined) return true;
  const want = new Map(made.map(([p, oid, mode]) => [p, `${oid} ${mode}`]));
  return index.length !== want.size || index.some((e) => e.stage !== 0 || want.get(e.path) !== `${e.oid} ${e.mode}`);
}

/** `headMessage`: HEAD's raw message, which a conflict at a fold shows (`seqShowsHeadMessage`). */
export function seqInProgress(fs: MemFs, gitdir: string, headMessage: string | null = null): InProgress | null {
  const s = readSync(fs, gitdir);
  if (!live(s)) return null;
  const n = conflicted(fs, gitdir);
  const stop = s.stop;
  const last = s.done.at(-1);
  // The message file git leaves: a pick's conflict lists its paths under `# Conflicts:` (a merge
  // step's and a fold's don't).
  const file = (pick: boolean) => normalise(stop === null ? '' : pick && stop.reason === 'conflict' && stop.conflicts?.length ? withConflicts(stop.message, stop.conflicts) : stop.message);
  if (s.kind === 'cherryPick') return { kind: 'cherryPick', head: stop!.at, message: file(true), conflicted: n };
  if (s.kind === 'revert') return { kind: 'revert', head: stop!.at, message: file(true), conflicted: n };
  // GitVolt's Edit stop is the core's soft-reset one (`EDIT_STAGED`): HEAD on the made commit's parent.
  const edit = stop?.reason === 'edit' ? stop : null;
  const fold = atFold(s);
  const editStop = edit?.made ?? (fold ? s.head : null);
  const message = edit ? `${trimEndRust(normalise(edit.message))}\n` : fold ? normalise(headMessage ?? '') : file(last?.op === 'pick');
  return {
    kind: 'rebase',
    onto: s.onto,
    headName: s.headName ?? 'detached HEAD',
    // git's `msgnum`: a step joins `done` as it starts, so the stopped one (or the one running) is the last.
    step: s.done.length,
    total: s.total,
    stoppedAt: stop?.at || null,
    editStop,
    editBase: edit?.editBase ?? null,
    editAdded: edit?.added ?? [],
    editChanged: edit !== null && indexDiffers(fs, gitdir, edit.madeFiles),
    editConflict: editStop === null && last?.op === 'pick' && last.edit === true,
    messageFailed: null,
    gitvolt: s.interactive,
    conflicted: n,
    message,
  };
}
