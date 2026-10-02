const parentOf = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf('/')));
const nameOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/** How a worktree is named in messages (spec #2 §9.3, §11.1): `../shop-feature-x` beside the
 * main worktree, else its absolute path. The backend's `display_worktree`, for the UI's own copy. */
export function worktreeDisplay(mainPath: string, path: string): string {
  return path !== mainPath && parentOf(path) === parentOf(mainPath) ? `../${nameOf(path)}` : path;
}
