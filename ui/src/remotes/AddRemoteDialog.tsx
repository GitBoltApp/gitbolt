import { useCallback, useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { api, errorMessage } from '../api/client';
import type { ForgeProject } from '../api/gen/ForgeProject';
import { useModalKeys } from '../app/modalKeys';
import { registerAppSlot } from '../app/slots';
import { useRuntime } from '../app/runtime';
import { useAppState } from '../app/state';
import { forgeOf } from '../forge/mrStore';
import { detectHostKind, HOST_KIND_NAMES } from '../forge/hostKind';
import { freeRemoteName, parseRemoteUrl, remoteNameError, remoteUrlError } from '../forge/remoteUrl';
import { effectiveKind } from '../forge/urls';
import { relativeTime } from '../format/relative';
import { RemoteIcon } from '../icons/brands';
import { addForkRemote, addRemoteAndFetch } from './addRemote';
import { remoteIsProject } from './match';
import './remotes.css';

const FORKS_PAGE = 10;

const useDialog = create<{ tabId: string | null }>(() => ({ tabId: null }));
/** Opens Add remote for a tab (the Remote panel's +, the palette). */
export const openAddRemote = (tabId: string) => useDialog.setState({ tabId });
export const closeAddRemote = () => useDialog.setState({ tabId: null });

export function AddRemoteDialog() {
  const tabId = useDialog((s) => s.tabId);
  return tabId ? <Form tabId={tabId} key={tabId} /> : null;
}

type Forks =
  | { status: 'none' }
  | { status: 'loading'; of: ForgeProject }
  | { status: 'ready'; of: ForgeProject; remote: string; list: ForgeProject[]; next: number | null; more: 'idle' | 'loading' | { error: string } }
  | { status: 'error'; of: ForgeProject; message: string };

function Form({ tabId }: { tabId: string }) {
  const rt = useRuntime((s) => s.tabs[tabId]);
  const overrides = useAppState((s) => s.profile.hostOverrides);
  const remotes = rt?.info?.remotes ?? [];
  const names = remotes.map((r) => r.name);
  const repoId = rt?.repo?.id;
  const [url, setUrl] = useState('');
  const [name, setName] = useState<string | null>(null); // null: follows the URL's owner
  const [forks, setForks] = useState<Forks>({ status: 'none' });
  // Decided at open from what the tab already knows, so the box is there from the first frame.
  const [expectForks] = useState(() => { const f = forgeOf(tabId); return f.kind !== null || f.mapped.length > 0; });
  const [lookedUp, setLookedUp] = useState(false);
  const inFlight = useRef(false);
  const generation = useRef(0); // bumps on each (re)open load: older answers are dropped
  const listRef = useRef<HTMLUListElement | null>(null);
  const sentinelRef = useRef<HTMLLIElement | null>(null);
  const ref = useModalKeys<HTMLDivElement>(true, closeAddRemote);
  const trimmed = url.trim();
  const parsed = parseRemoteUrl(trimmed);
  const effName = name ?? (parsed ? freeRemoteName(parsed.path.split('/')[0] ?? '', names) : '');
  const urlError = remoteUrlError(trimmed);
  const nameError = remoteNameError(effName, names);
  const kind = parsed ? effectiveKind(parsed.host, detectHostKind(parsed.host), overrides) : null;

  // The target project's forks (spec #4 §3.3), when the repo maps to a project through an account.
  useEffect(() => {
    if (repoId === undefined) return;
    let live = true;
    const gen = ++generation.current;
    inFlight.current = false;
    void (async () => {
      const projects = await api.forgeRepoProjects(repoId).catch(() => null);
      const target = projects?.remotes.find((r) => r.remote === projects.target);
      if (!live) return;
      if (!target?.project) { setLookedUp(true); return; }
      const of = target.project;
      setForks({ status: 'loading', of });
      try {
        const page = await api.forgeForks(repoId, target.remote, 1, FORKS_PAGE);
        if (live) setForks({ status: 'ready', of, remote: target.remote, list: page.forks, next: page.next, more: 'idle' });
      } catch (e) {
        if (live) setForks({ status: 'error', of, message: errorMessage(e) });
      }
    })();
    return () => { live = false; generation.current = gen + 1; };
  }, [repoId]);

  const next = forks.status === 'ready' && forks.more === 'idle' ? forks.next : null;
  const loadMore = useCallback(async () => {
    if (inFlight.current || repoId === undefined) return;
    const cur = forks;
    if (cur.status !== 'ready' || cur.next === null) return;
    inFlight.current = true;
    const gen = generation.current;
    setForks({ ...cur, more: 'loading' });
    try {
      const page = await api.forgeForks(repoId, cur.remote, cur.next, FORKS_PAGE);
      if (gen !== generation.current) return;
      const seen = new Set(cur.list.map((f) => f.path));
      setForks({ ...cur, list: [...cur.list, ...page.forks.filter((f) => !seen.has(f.path))], next: page.next, more: 'idle' });
    } catch (e) {
      if (gen === generation.current) setForks({ ...cur, more: { error: errorMessage(e) } });
    } finally {
      inFlight.current = false;
    }
  }, [forks, repoId]);
  const loadMoreRef = useRef(loadMore);
  loadMoreRef.current = loadMore;

  // The sentinel at the end of the list loads the next page as it nears view.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || next === null || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) void loadMoreRef.current(); }, { root: listRef.current, rootMargin: '0px 0px 80px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [next, forks.status === 'ready' ? forks.list.length : 0]);

  const submit = () => {
    if (urlError || nameError) return;
    closeAddRemote();
    void addRemoteAndFetch(tabId, effName, trimmed);
  };
  const addFork = (fork: ForgeProject) => {
    closeAddRemote();
    void addForkRemote(tabId, fork);
  };
  const addedAs = (fork: ForgeProject) => remotes.find((r) => remoteIsProject(r, fork.host, fork.path))?.name ?? null;

  return (
    <div className="modal-backdrop" onPointerDown={closeAddRemote}>
      <div ref={ref} className="modal add-remote" role="dialog" aria-modal="true" aria-labelledby="add-remote-title" onPointerDown={(e) => e.stopPropagation()}>
        <h2 id="add-remote-title">Add remote</h2>
        <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <label className="modal-field">
            <span>URL</span>
            <input aria-label="Remote URL" autoFocus spellCheck={false} placeholder="https://gitlab.example.com/group/project.git" value={url} onChange={(e) => setUrl(e.target.value)} />
          </label>
          {parsed && kind && (
            <p className="add-remote-detected" data-testid="add-remote-detected">
              <RemoteIcon kind={detectHostKind(parsed.host)} host={parsed.host} remote={effName || 'remote'} /> {kind === 'generic' ? '' : `${HOST_KIND_NAMES[kind]} · `}{parsed.host}/{parsed.path}
            </p>
          )}
          <label className="modal-field">
            <span>Name</span>
            <input aria-label="Remote name" spellCheck={false} value={effName} onChange={(e) => setName(e.target.value)} />
          </label>
          {trimmed && (urlError ?? nameError) && <p role="alert" className="modal-error">{urlError ?? nameError}</p>}
          <div className="modal-actions">
            <button type="button" onClick={closeAddRemote}>Cancel</button>
            <button type="submit" className="primary" disabled={!!urlError || !!nameError}>Add remote</button>
          </div>
        </form>
        {(expectForks || forks.status !== 'none') && (
          <section className="add-remote-forks" aria-label="Forks">
            <h3>{forks.status === 'none' ? 'Forks' : `Forks of ${forks.of.path}`}</h3>
            {/* One box of fixed height from the first frame, so the dialog never resizes as forks arrive (or none do). */}
            <div className="fork-box" data-testid="fork-box">
            {forks.status === 'none' && <p className="dim">{lookedUp ? 'No forks to show' : 'Loading forks…'}</p>}
            {forks.status === 'loading' && <p className="dim">Loading forks…</p>}
            {forks.status === 'error' && <p role="alert" className="modal-error">{forks.message}</p>}
            {forks.status === 'ready' && forks.list.length === 0 && <p className="dim">No forks yet</p>}
            {forks.status === 'ready' && forks.list.length > 0 && (
              <ul className="fork-list" ref={listRef}>
                {forks.list.map((f) => {
                  const as = addedAs(f);
                  return (
                    <li key={f.path} className="fork-row">
                      <span className="fork-path">{f.path}</span>
                      <span className="dim fork-meta">{f.defaultBranch ?? 'empty'}{f.updatedAt ? ` · updated ${relativeTime(f.updatedAt)}` : ''}</span>
                      {as ? <span className="dim">Added as {as}</span> : <button type="button" aria-label={`Add ${f.owner.split('/').pop() || f.owner}'s fork`} onClick={() => addFork(f)}>Add</button>}
                    </li>
                  );
                })}
                {(forks.next !== null || forks.more !== 'idle') && (
                  <li className="fork-more" ref={sentinelRef}>
                    {forks.more === 'loading' && <span className="dim">Loading…</span>}
                    {typeof forks.more === 'object' && (
                      <span role="alert" className="modal-error">Couldn't load more forks: {forks.more.error} <button type="button" onClick={() => void loadMore()}>Retry</button></span>
                    )}
                    {forks.more === 'idle' && forks.next !== null && <button type="button" onClick={() => void loadMore()}>Load more forks</button>}
                  </li>
                )}
              </ul>
            )}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

export const offAddRemoteDialog = registerAppSlot('overlay', 'addRemote', AddRemoteDialog);
