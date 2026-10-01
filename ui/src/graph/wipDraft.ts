/**
 * The per-worktree draft commit summary typed into a WIP row (K48). Sub-project #2 seam: the
 * commit panel reads `readWipDraft(repoId, worktreePath)` to prefill its summary box (and, with
 * stashing, the same text becomes the stash message, spec §8.6), and may `writeWipDraft(…, '')`
 * after a commit. Persisted in localStorage per repo + worktree path; every access is
 * best-effort (private windows and blocked storage just forget the draft).
 */
export const WIP_DRAFT_MAX = 72;
/** The length past which the counter shows (the summary counter). */
export const WIP_DRAFT_COUNTER_FROM = 60;

const key = (repoId: string, worktreePath: string) => `gitbolt.wipDraft.v1:${repoId}\u0000${worktreePath}`;

export function readWipDraft(repoId: string, worktreePath: string): string {
  try {
    return (localStorage.getItem(key(repoId, worktreePath)) ?? '').slice(0, WIP_DRAFT_MAX);
  } catch {
    return '';
  }
}

/** Stores `text`; an empty draft removes the entry. */
export function writeWipDraft(repoId: string, worktreePath: string, text: string): void {
  try {
    if (text) localStorage.setItem(key(repoId, worktreePath), text);
    else localStorage.removeItem(key(repoId, worktreePath));
  } catch {
    /* storage unavailable: the draft lives only as long as the row */
  }
}
