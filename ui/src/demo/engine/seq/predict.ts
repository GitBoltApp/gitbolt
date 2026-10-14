// Conflict prediction for the interactive rebase editor (the core's write/irebase/predict.rs):
// each planned row, oldest first, merged onto the previous simulated result. Nothing touches the
// worktree, the index, the refs or the journal. The trees the merges write are unreferenced objects
// in the demo's store (the core writes them, and its step commits, to a throwaway object directory);
// no step commit is written here: the simulated tip is a tree once a row has been merged.
import type { Prediction } from '../../../api/gen/Prediction';
import type { RebaseRow } from '../../../api/gen/RebaseRow';
import type { RowPrediction } from '../../../api/gen/RowPrediction';
import { compareBytewise } from '../read/bytes';
import { readCommit } from '../read/commitText';
import { revParse } from '../read/revs';
import type { ReadRepo } from '../read/seam';
import { replay, treeOf } from './replay';

export const LIMIT = 300;
/** The newest prediction asked for, per worktree: an older one still running stops at its next row. */
const latest = new Map<string, number>();
const off = (why: string): Prediction => ({ rows: [], off: why });

export async function predict(read: ReadRepo, key: string, root: string, base: string, rows: RebaseRow[]): Promise<Prediction> {
  if (rows.length > LIMIT) return off('Prediction is off for ranges over 300 commits');
  const generation = (latest.get(key) ?? 0) + 1;
  latest.set(key, generation);
  const live = () => latest.get(key) === generation;
  try {
    // A turn of the event loop first, so a newer ask made at once supersedes this one.
    await Promise.resolve();
    // The simulated tip: a real commit while rows fast-forward, then only its tree.
    let atCommit: string | null = await revParse(read, `${base}^{commit}`, root);
    let atTree = await treeOf(read, atCommit);
    const out: RowPrediction[] = [];
    for (const r of [...rows].reverse()) {
      if (r.action === 'drop') continue;
      if (!live()) return off('Superseded');
      const c = await readCommit(read, r.oid);
      // A root commit has no merge base to replay it with: no prediction, not a clean row.
      if (c.parents.length === 0) throw new Error(`${r.oid} is a root commit`);
      if (atCommit !== null && c.parents[0] === atCommit) {
        // git fast-forwards it: nothing to merge.
        atCommit = r.oid;
        atTree = c.tree;
        out.push({ oid: r.oid, conflicts: [] });
        continue;
      }
      const merged = await replay(read, r.oid, atTree, 'pick');
      if (merged.tree !== null) {
        atTree = merged.tree;
        atCommit = null;
      }
      // A conflicting row: the rows after it continue from its "ours" side.
      out.push({ oid: r.oid, conflicts: [...new Set(merged.conflicts)].sort(compareBytewise) });
    }
    return live() ? { rows: out, off: null } : off('Superseded');
  } catch {
    return off("Couldn't predict conflicts");
  }
}
