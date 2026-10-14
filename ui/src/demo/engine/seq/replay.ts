// One commit's change replayed onto another tree: the cherry-pick, rebase pick and revert of the
// sequencer (plan 4). A pick merges (base: the commit's first parent, ours: the tree it goes onto,
// theirs: the commit); a revert swaps base and theirs. Labels as git 2.53 writes them (checked
// against the binary, Task 2 Step 1): the commit's message by its first non-blank line as it is, not
// its `%s`. Not as git does: the id is always 7 digits (git lengthens it in a large repository).
import { firstLine, readCommit, type ParsedCommit } from '../read/commitText';
import type { ReadRepo } from '../read/seam';
import { mergeTrees, writeTreeOf, type MergeResult } from '../writeSeam';
import { shortOid } from './range';

export { EMPTY_TREE } from '../writeSeam';
export type How = 'pick' | 'revert';

export async function treeOf(read: ReadRepo, commit: string): Promise<string> {
  return (await readCommit(read, commit)).tree;
}

/** The merge labels git writes for `how` of `oid`: ours `HEAD`, theirs `<short7> (<subject>)` or `parent of <short7> (<subject>)`. */
export function labelsFor(how: How, oid: string, c: ParsedCommit): { ours: string; theirs: string; base: string } {
  const named = `${shortOid(oid)} (${firstLine(c.rawMessage)})`;
  return how === 'pick' ? { ours: 'HEAD', theirs: named, base: `parent of ${named}` } : { ours: 'HEAD', theirs: `parent of ${named}`, base: named };
}

/** `oid`'s change against its first parent (a revert: reversed), merged onto the tree `ontoTree`. */
export async function replay(read: ReadRepo, oid: string, ontoTree: string, how: How): Promise<MergeResult> {
  const c = await readCommit(read, oid);
  const parentTree = c.parents.length > 0 ? await treeOf(read, c.parents[0]) : null;
  const labels = labelsFor(how, oid, c);
  if (how === 'pick') return mergeTrees(read, { base: parentTree, ours: ontoTree, theirs: c.tree, labels });
  // A root commit's revert merges towards the empty tree.
  return mergeTrees(read, { base: c.tree, ours: ontoTree, theirs: parentTree ?? (await writeTreeOf(read, [])), labels });
}
