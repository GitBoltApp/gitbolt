import { LoaderCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../api/client';
import type { GbError } from '../api/gen/GbError';
import { useOps } from '../app/ops';
import { openPathInTab } from '../app/runtime';
import { useAppState } from '../app/state';
import { cloneDestProblem, cloneUrlProblem } from './cloneInput';
import { repoNameFromUrl } from './repoName';

/** Spec §13: the URL, a destination that follows it until edited, progress, Cancel, inline errors. */
export function CloneForm({ tabId, autoFocus }: { tabId: string; autoFocus: boolean }) {
  const reposFolder = useAppState((s) => s.profile.reposFolder);
  const [url, setUrl] = useState('');
  const [dest, setDest] = useState('');
  const [destEdited, setDestEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const urlRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (autoFocus) urlRef.current?.focus(); }, [autoFocus]);
  useEffect(() => {
    if (destEdited) return;
    const name = repoNameFromUrl(url);
    setDest(reposFolder && name ? `${reposFolder.replace(/\/+$/, '')}/${name}` : '');
  }, [url, reposFolder, destEdited]);
  // The clone's op is labelled with its destination (`opStarted.label`).
  const op = useOps((s) => (busy ? Object.values(s.ops).find((o) => o.kind === 'clone' && o.label === dest.trim()) : undefined));

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const repo = await api.clone(url.trim(), dest.trim());
      // The tab that started the clone may be gone (closed) or no longer an Open tab: the
      // result then opens in a tab of its own instead of applying to a dead tab id.
      const here = useAppState.getState().profile.tabs.find((t) => t.id === tabId);
      await openPathInTab(repo.path, here?.kind === 'open' ? tabId : undefined);
    } catch (e) {
      const kind = (e as GbError | null)?.kind;
      setError(kind === 'AuthFailed' ? 'Authentication failed or was cancelled' : kind === 'Cancelled' ? 'Clone cancelled' : errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const problem = cloneUrlProblem(url) ?? cloneDestProblem(dest);
  const percent = op?.percent ?? null;
  return (
    <form className="clone-form" onSubmit={(e) => { e.preventDefault(); if (!busy) void submit(); }}>
      <label>Repository URL <input ref={urlRef} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="git@gitlab.example.com:group/project.git" aria-label="Repository URL" disabled={busy} spellCheck={false} /></label>
      <label>Destination <input value={dest} onChange={(e) => { setDest(e.target.value); setDestEdited(true); }} placeholder="/home/you/repos/project" aria-label="Destination" disabled={busy} spellCheck={false} /></label>
      {busy && (
        <div className="clone-progress">
          <LoaderCircle size={14} className="spin" />
          <span>{op?.phase ?? 'Starting…'}{percent !== null ? ` ${percent}%` : ''}</span>
          <progress max={100} value={percent ?? undefined} aria-label="Clone progress" />
          {op && <button type="button" className="open-btn" onClick={() => void api.cancelOp(op.op)}>Cancel</button>}
        </div>
      )}
      {problem && !busy && <p className="open-error" role="alert">{problem}</p>}
      {error && <p className="open-error" role="alert">{error}</p>}
      <div className="open-actions"><button type="submit" className="open-btn primary" disabled={busy || !url.trim() || !dest.trim() || problem !== null}>Clone</button></div>
    </form>
  );
}
