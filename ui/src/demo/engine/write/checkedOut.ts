// A branch checked out in a worktree: where, as the UI names it (precheck::display_worktree), and
// the refusal the core gives (GbError::checked_out_elsewhere).
import type { GbError } from '../../../api/gen/GbError';
import { gbError } from '../errors';
import { parentOf } from '../memfs';
import { listWorktrees } from '../read/worktrees';
import type { WriteWt } from './seam';

/** `../<name>` for a worktree beside the main one, else its absolute path. A fixture's extra
 *  folders (`/demo/.extra/<repo>/<piece>`, 1a's layout) sat beside its main worktree in the
 *  fixture folder the core recorded, so they show as `../<piece>` too, as the core shows them. */
export function displayWorktree(main: string, path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const beside = parentOf(main) === parentOf(path) || parentOf(path) === `/demo/.extra/${main.slice(main.lastIndexOf('/') + 1)}`;
  return beside && main !== path ? `../${name}` : path;
}

export function checkedOutElsewhere(branch: string, shown: string): GbError {
  return { ...gbError('InvalidInput', `${branch} is checked out in ${shown}.`), detail: { kind: 'checkedOutElsewhere', branch, worktree: shown } };
}

export async function elsewhere(wt: WriteWt, full: string): Promise<string | null> {
  const all = await listWorktrees(wt.repo);
  const main = all.find((w) => w.isMain)?.path ?? wt.repo.dir;
  const w = all.find((x) => x.branch === full && x.path !== wt.root);
  return w ? displayWorktree(main, w.path) : null;
}
