import { useState } from 'react';
import { api, errorMessage } from '../api/client';
import type { DiffContentsPayload } from '../api/gen/DiffContentsPayload';
import type { LfsSide } from '../api/gen/LfsSide';
import { useRepoContext } from '../app/repoContext';
import { formatBytes } from '../diff/format';
import { oldCommitOf, type DiffSides } from '../diff/markdownDiffSides';
import type { FileCommit } from '../nav/history';
import { fileCommitOf } from '../nav/repoPlaces';
import { useRepoViewStore, type DiffTarget } from '../repo/store';
import { ArrowGlyph } from '../ui/ArrowGlyph';
import { useToast } from '../ui/toastStore';
import { runWrite } from '../write/client';
import { INSTALL_COMMAND, lfsDownloaded, NOT_SET_UP, useLfsStatus } from './store';
import './lfs.css';

/** The diff's LFS sides whose real file isn't downloaded (old first). */
export const lfsMissing = (c: DiffContentsPayload): LfsSide[] => [c.old?.lfs, c.new?.lfs].filter((l): l is LfsSide => !!l && !l.downloaded);

const isCommit = (c: FileCommit | null): c is string => !!c && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(c);

/**
 * In place of a diff (or a file) whose LFS file isn't downloaded: "LFS file (3.2 MB), not
 * downloaded", and Download, which fetches that file at the diff's commits (and checks it out
 * when the working tree has it as a pointer), then the views read it again. "Show pointer" shows
 * what's stored in git instead. The pointer text is never shown as if it were the file.
 * `sides`: the commits of the two sides when the caller knows them (File History); else they come
 * from the tab's selection, as a Markdown diff's do.
 */
export function LfsPlaceholder({ target, contents, sides }: { target: DiffTarget; contents: DiffContentsPayload; sides?: DiffSides }) {
  const { tabId, repoId, worktree } = useRepoContext();
  const store = useRepoViewStore();
  const [pointer, setPointer] = useState(false);
  const [busy, setBusy] = useState(false);
  // Without git-lfs nothing can download it: Download is off, with where to get git-lfs.
  const status = useLfsStatus(repoId);
  const missingLfs = !!status && !status.version;
  const install = () => {
    if (status) api.openUrl(status.installUrl).catch((e: unknown) => useToast.getState().show(`Couldn't open ${status.installUrl}: ${errorMessage(e)}`, { error: true }));
  };
  const missing = lfsMissing(contents);
  const sizes = missing.map((l) => formatBytes(l.size));
  const download = async () => {
    const s = store.getState();
    const commits = sides ? [sides.old, sides.new] : [oldCommitOf(s, target), fileCommitOf(s, target)];
    const refs = [...new Set(commits.filter(isCommit))];
    setBusy(true);
    try {
      await runWrite({ tabId, repoId, worktree }, () => api.lfsDownload(repoId, worktree, target.path, refs, missing.map((l) => l.oid)), {
        onSuccess: (out) => {
          lfsDownloaded();
          if (out.missing.length) useToast.getState().show(`git-lfs didn't find ${target.path} on the remote`, { error: true });
          else if (out.notSetUp) useToast.getState().show(`Downloaded ${target.path}. ${NOT_SET_UP}`, { tone: 'warning', detail: INSTALL_COMMAND });
        },
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="diff-message lfs-placeholder" data-testid="lfs-placeholder">
      <p>LFS file ({sizes.length === 2 && sizes[0] !== sizes[1] ? <>{sizes[0]} <ArrowGlyph /> {sizes[1]}</> : sizes[0]}), not downloaded</p>
      <div className="lfs-actions">
        <button type="button" className="text-button lfs-download" disabled={busy || missingLfs} aria-busy={busy} onClick={() => void download()}>{busy ? 'Downloading…' : 'Download'}</button>
        <button type="button" className="text-button" aria-pressed={pointer} onClick={() => setPointer((p) => !p)}>{pointer ? 'Hide pointer' : 'Show pointer'}</button>
      </div>
      {missingLfs && (
        <p className="dim" data-testid="lfs-install-hint">
          git-lfs isn't installed, so it can't be downloaded.
          <button type="button" className="lfs-install" onClick={install}>Install git-lfs</button>
        </p>
      )}
      {pointer && missing.map((l) => <pre key={l.oid} className="lfs-pointer" aria-label="LFS pointer">{l.pointer}</pre>)}
    </div>
  );
}
