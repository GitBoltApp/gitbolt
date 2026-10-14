// Patch equivalence, for `--cherry-mark` (rebasePlan's `upstream`) and plain rebase's leaving out
// of commits the target already has. Written from what the git binary shows (2.53, Task 2 Step 1),
// not git's code: two commits are equivalent when their diffs against their first parents (no
// rename detection, three lines of context) read the same once every space, tab, CR and line break
// is taken out (not a form feed or vertical tab): the lines run together, a context line's leading
// space and a path included. Line numbers, hunk headers and boundaries, an unchanged file mode and
// `\ No newline at end of file` don't count; a file's path, its creation or deletion and a mode
// change do. A binary file (or a gitlink) counts by its blob ids. Where it can differ: hunks come
// from 1b's line diff (no indent heuristic, and past its MAX_EDIT_LENGTH of 4,000 edits every
// remaining line counts as changed), so a slider may sit elsewhere than git's and change the context
// lines; `.gitattributes` isn't read.
import { blobId, isBinaryHead, latin1, utf8Bytes } from '../read/bytes';
import { readCommit } from '../read/commitText';
import { diffLines, splitLines, unifiedHunks } from '../read/lineDiff';
import type { ReadRepo } from '../read/seam';
import { diffTrees, MODE_GITLINK, modeType, readBlobBytes, type FileEntry, type TreeChange } from '../read/trees';

const strip = (line: string) => line.replace(/[ \t\n\r]+/g, '');
const octal = (e: FileEntry) => e.mode.toString(8);
const isGitlink = (e: FileEntry | null) => e !== null && modeType(e.mode) === MODE_GITLINK;

/** The changes `oid` makes against its first parent (diffTrees sorts them bytewise, as git's diff
 *  does); `null` for a merge. */
async function changesOf(read: ReadRepo, oid: string): Promise<TreeChange[] | null> {
  const c = await readCommit(read, oid);
  if (c.parents.length > 1) return null;
  const parentTree = c.parents.length === 1 ? (await readCommit(read, c.parents[0])).tree : null;
  return diffTrees(read, parentTree, c.tree);
}

const headerOf = (ch: TreeChange): string => {
  const modes = ch.old === null ? `new ${octal(ch.new!)}` : ch.new === null ? `deleted ${octal(ch.old)}` : ch.old.mode !== ch.new.mode ? `${octal(ch.old)} ${octal(ch.new)}` : '';
  return `\u0000${strip(ch.path)}\u0000${modes}\u0000`;
};

/** What a patch id says of the files alone (their paths, creations, deletions and mode changes),
 *  from the trees, no blob read: two commits with different headers never share a patch id, so
 *  only the commits whose header matches need theirs. `null` for a merge. */
export async function patchHeader(read: ReadRepo, oid: string): Promise<string | null> {
  return (await changesOf(read, oid))?.map(headerOf).join('') ?? null;
}

/** A stable id of the change `oid` makes against its first parent, whitespace and line numbers ignored; `null` for a merge. */
export async function patchId(read: ReadRepo, oid: string): Promise<string | null> {
  const changes = await changesOf(read, oid);
  if (changes === null) return null;
  const parts: string[] = [];
  for (const ch of changes) {
    parts.push(headerOf(ch));
    if (isGitlink(ch.old) || isGitlink(ch.new)) {
      parts.push(`\u0001${ch.old?.oid ?? ''}\u0001${ch.new?.oid ?? ''}`);
      continue;
    }
    const a = ch.old ? await readBlobBytes(read, ch.old.oid) : new Uint8Array();
    const b = ch.new ? await readBlobBytes(read, ch.new.oid) : new Uint8Array();
    if (isBinaryHead(a) || isBinaryHead(b)) {
      parts.push(`\u0001${ch.old?.oid ?? ''}\u0001${ch.new?.oid ?? ''}`);
      continue;
    }
    const [al, bl] = [splitLines(latin1(a)), splitLines(latin1(b))];
    for (const h of unifiedHunks(al, bl, diffLines(al, bl))) {
      for (const l of h.lines) parts.push(l.kind === 'context' ? strip(l.text) : `${l.kind === 'add' ? '+' : '-'}${strip(l.text)}`);
    }
  }
  return blobId(utf8Bytes(parts.join('')));
}

/** The commits of `mine` whose patch id one of `theirs` shares (`rev-list --cherry-mark`'s `=` on
 *  `mine`'s side; a merge on either side never matches). `emptyToo`: an empty commit matches an
 *  empty one, as `--cherry-mark` has it (checked on the binary); a rebase never leaves one out.
 *  Patch ids are read only where the trees' headers match: a long side costs a tree diff per
 *  commit, no blob. */
export async function samePatches(read: ReadRepo, mine: string[], theirs: string[], emptyToo: boolean): Promise<Set<string>> {
  const headers = new Map<string, string>();
  for (const oid of mine) {
    const h = await patchHeader(read, oid);
    if (h !== null && (emptyToo || h !== '')) headers.set(oid, h);
  }
  const out = new Set<string>();
  if (headers.size === 0) return out;
  const wanted = new Set(headers.values());
  const ids = new Set<string>();
  for (const oid of theirs) {
    const h = await patchHeader(read, oid);
    if (h === null || !wanted.has(h)) continue;
    const id = await patchId(read, oid);
    if (id !== null) ids.add(id);
  }
  if (ids.size === 0) return out;
  for (const oid of headers.keys()) {
    const id = await patchId(read, oid);
    if (id !== null && ids.has(id)) out.add(oid);
  }
  return out;
}
