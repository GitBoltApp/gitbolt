import { CloudDownload, Download, FileMinus, FilePlus } from 'lucide-react';
import { api, onEvent } from '../api/client';
import { activeTab, registerActions } from '../app/actions';
import type { FileTarget, MenuEnv } from '../menu/menuEnv';
import { registerMenu } from '../menu/registry';
import type { MenuRow } from '../menu/types';
import { useToast } from '../ui/toastStore';
import { runWrite, type WriteCtx } from '../write/client';
import { writeCtx } from '../write/ctx';
import { INSTALL_COMMAND, lfsDownloaded, lfsStatusOf, NOT_SET_UP, onLfsEvent, onLfsFocus, refreshLfs, trackedOf } from './store';

/** The active repo tab's write target. */
function activeCtx(): WriteCtx | null {
  const t = activeTab();
  return t?.kind === 'repo' ? writeCtx(t.id) : null;
}

/** The repository uses LFS and git-lfs is installed (Fetch and Pull need both). */
const lfsReady = (repo: number) => {
  const s = lfsStatusOf(repo);
  return !!s?.used && !!s.version;
};

/** `git lfs pull` or `git lfs fetch` for the active tab, as a queued write with Activity output. */
async function transfer(kind: 'pull' | 'fetch'): Promise<void> {
  const ctx = activeCtx();
  if (!ctx) return;
  await runWrite(ctx, () => (kind === 'pull' ? api.lfsPull(ctx.repoId, ctx.worktree) : api.lfsFetch(ctx.repoId, ctx.worktree)), {
    onSuccess: (out) => {
      lfsDownloaded();
      if (out.notSetUp) useToast.getState().show(`Fetched the LFS files. ${NOT_SET_UP}`, { tone: 'warning', detail: INSTALL_COMMAND });
      else useToast.getState().show(kind === 'pull' ? 'Pulled the LFS files' : 'Fetched the LFS files');
    },
  });
}

/** `*.<ext>` for a file with an extension git-lfs can track as a pattern; `null` otherwise
 * (no extension, a dotfile, characters a pattern would read as a glob). */
export function extPattern(path: string): string | null {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return null;
  const ext = name.slice(dot + 1);
  return /^[^\s/\\*?[\]!#"']+$/.test(ext) ? `*.${ext}` : null;
}

/** Track or stop tracking `pattern`: `.gitattributes` changes (a WIP change to commit), undoable. */
async function setTracked(ctx: WriteCtx, pattern: string, track: boolean): Promise<void> {
  await runWrite(ctx, () => (track ? api.lfsTrack(ctx.repoId, ctx.worktree, pattern) : api.lfsUntrack(ctx.repoId, ctx.worktree, pattern)), {
    onSuccess: async () => {
      await refreshLfs(ctx.repoId);
      const setUp = lfsStatusOf(ctx.repoId)?.filter ?? true;
      if (!track) useToast.getState().show(`Stopped tracking ${pattern} with Git LFS`);
      // Without git lfs install, git commits these files whole: say so, with the command.
      else if (!setUp) useToast.getState().show(`Tracking ${pattern} with Git LFS, but git-lfs isn't set up in this repository yet: run git lfs install before you commit`, { tone: 'warning', detail: INSTALL_COMMAND });
      else useToast.getState().show(`Tracking ${pattern} with Git LFS: commit .gitattributes to share it`);
    },
  });
}

const row = (r: Omit<Extract<MenuRow, { kind: 'action' }>, 'kind'>): MenuRow => ({ kind: 'action', ...r });

const offs = [
  registerActions([
    { id: 'lfs.pull', label: 'LFS: Pull', group: 'Repository', icon: CloudDownload, tooltip: 'Download the Git LFS files of the checked-out commit and put them in the working tree (git lfs pull)', when: () => { const c = activeCtx(); return !!c && lfsReady(c.repoId); }, run: () => transfer('pull') },
    { id: 'lfs.fetch', label: 'LFS: Fetch', group: 'Repository', icon: Download, tooltip: 'Download the Git LFS files of the checked-out commit, leaving the working tree as it is (git lfs fetch)', when: () => { const c = activeCtx(); return !!c && lfsReady(c.repoId); }, run: () => transfer('fetch') },
  ]),
  // A file row's Track *.<ext> with LFS (git-lfs installed), or Stop tracking *.<ext> for a file
  // LFS stores. In its own group, after the others.
  registerMenu<FileTarget, MenuEnv>({
    id: 'file.lfs', kind: 'file', group: 'lfs', order: 0,
    when: (_t, env) => env.write !== null,
    rows: (t, env) => {
      const ctx = env.write;
      const pattern = extPattern(t.path);
      const status = ctx ? lfsStatusOf(ctx.repoId) : undefined;
      if (!ctx || !pattern || !status?.version) return [];
      // Only once it's known whether LFS stores it; Stop tracking only for the `*.<ext>` line
      // that does (another rule's file has nothing here to stop).
      const tracked = status.used ? trackedOf(ctx.repoId, ctx.worktree, t.path) : false;
      if (tracked === undefined || (tracked && !status.patterns.includes(pattern))) return [];
      return tracked
        ? [row({ id: 'file.lfsUntrack', label: `Stop tracking ${pattern}`, icon: FileMinus, tooltip: `Stop storing ${pattern} files with Git LFS (git lfs untrack): .gitattributes changes, and you can undo this`, run: () => void setTracked(ctx, pattern, false) })]
        : [row({ id: 'file.lfsTrack', label: `Track ${pattern} with LFS`, icon: FilePlus, tooltip: `Store ${pattern} files with Git LFS (git lfs track): .gitattributes changes, and you can undo this`, run: () => void setTracked(ctx, pattern, true) })];
    },
  }),
  // Checkouts, pulls, .gitattributes edits and git-lfs installed meanwhile (`refreshLfs`).
  onEvent(onLfsEvent),
  (() => {
    window.addEventListener('focus', onLfsFocus);
    return () => window.removeEventListener('focus', onLfsFocus);
  })(),
];
import.meta.hot?.dispose(() => { for (const off of offs) off(); });
