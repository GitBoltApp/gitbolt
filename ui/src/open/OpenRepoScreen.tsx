import { FolderOpen, GitBranch, Pin, PinOff, Plus, RefreshCw, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api, errorMessage } from '../api/client';
import type { ScannedRepo } from '../api/gen/ScannedRepo';
import type { TabState } from '../api/gen/TabState';
import { openPathInTab, useRuntime } from '../app/runtime';
import { useAppState } from '../app/state';
import { removeRecent, togglePinRecent } from '../app/tabs';
import { relativeTime } from '../format/relative';
import { HoverTooltip } from '../ui/HoverTooltip';
import { CloneForm } from './CloneForm';
import { useOpenUi } from './openUi';
import './open.css';

function ReposFolderBanner() {
  const [suggestion, setSuggestion] = useState<string | null>(null);
  useEffect(() => { void api.suggestReposFolder().then(setSuggestion, () => undefined); }, []);
  const [error, setError] = useState<string | null>(null);
  const set = (p: string) => useAppState.getState().updateProfile((prof) => {
    const folders = prof.reposFolders ?? [];
    return { ...prof, reposFolder: p, reposFolders: folders.includes(p) ? folders : [...folders, p] };
  });
  return (
    <div className="open-banner" role="region" aria-label="Default repos folder">
      <span>Set a default repos folder: it's where clones go (and “Your repos” scans it).</span>
      {suggestion && <button type="button" className="open-btn primary" onClick={() => set(suggestion)}>Use {suggestion}</button>}
      <button type="button" className="open-btn" onClick={async () => {
        try {
          const p = await api.pickFolder(null);
          if (p) set(p);
        } catch (e) {
          setError(errorMessage(e));
        }
      }}>Choose…</button>
      {error && <span className="open-error" role="alert">{error}</span>}
    </div>
  );
}

const sameFolder = (a: string, b: string) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

/** "Your repos": every folder in the profile's list, merged. Only the list scrolls. */
function YourRepos({ folders, onOpen }: { folders: string[]; onOpen(path: string): void }) {
  const [repos, setRepos] = useState<ScannedRepo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = folders.join('\n');
  const load = (refresh: boolean) => {
    setError(null);
    if (folders.length === 0) { setRepos([]); return; }
    void api.scanFolders(folders, refresh).then(setRepos, (e: unknown) => { setRepos([]); setError(errorMessage(e)); });
  };
  useEffect(() => { load(false); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const update = useAppState((s) => s.updateProfile);
  const setFolders = (next: string[]) => update((p) => ({ ...p, reposFolders: next }));
  const add = async () => {
    try {
      const picked = await api.pickFolder(folders[folders.length - 1] ?? null);
      if (picked && !folders.some((f) => sameFolder(f, picked))) setFolders([...folders, picked]);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  // A "Clone from forge" entry would sit next to the + (K90, needs forge tokens).
  return (
    <section className="open-section open-yours" aria-labelledby="open-yours">
      <h2 id="open-yours">Your repos
        <HoverTooltip content="Scan the folders again"><button type="button" className="open-icon-btn" aria-label="Refresh" onClick={() => load(true)}><RefreshCw size={13} /></button></HoverTooltip>
        <HoverTooltip content="Add a folder to scan"><button type="button" className="open-icon-btn" aria-label="Add folder" onClick={() => void add()}><Plus size={14} /></button></HoverTooltip>
      </h2>
      <ul className="open-folders" aria-label="Scanned folders">
        {folders.map((f) => (
          <li key={f} className="open-folder-chip" title={f}>
            <span className="dim open-folder-path">{f}</span>
            <HoverTooltip content="Stop scanning this folder">
              <button type="button" className="open-icon-btn" aria-label={`Remove folder ${f}`} onClick={() => setFolders(folders.filter((x) => x !== f))}><X size={12} /></button>
            </HoverTooltip>
          </li>
        ))}
      </ul>
      {error && <p className="open-error" role="alert">Couldn't scan: {error}</p>}
      <div className="open-scroll">
        {folders.length === 0 ? <p className="dim">Add a folder with + and its repositories are listed here.</p> : repos === null ? <p className="dim">Scanning…</p> : repos.length === 0 ? (error ? null : <p className="dim">No repositories found two levels deep.</p>) : (
          <ul className="open-list">
            {repos.map((r) => (
              <li key={r.path}>
                <button type="button" className="open-row" onClick={() => onOpen(r.path)} title={r.path}>
                  <span className="open-name">{r.name}</span>
                  <span className="dim open-branch"><GitBranch size={11} /> {r.branch ?? 'detached'}</span>
                  <span className="dim open-when">{relativeTime(r.modified)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/** Spec §13, shown in an Open tab (folder icon, Ctrl+O, or when no tab is open). */
export function OpenRepoScreen({ tab }: { tab: TabState }) {
  const recent = useAppState((s) => s.profile.recent);
  const reposFolder = useAppState((s) => s.profile.reposFolder);
  const reposFolders = useAppState((s) => s.profile.reposFolders);
  const folders = useMemo(() => reposFolders ?? (reposFolder ? [reposFolder] : []), [reposFolders, reposFolder]);
  const focusClone = useOpenUi((s) => s.focusClone === tab.id);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);
  // The recent entry whose open just failed: the error offers to drop it.
  const [failedRecent, setFailedRecent] = useState<string | null>(null);
  useEffect(() => { if (focusClone) useOpenUi.getState().consume(); }, [focusClone]);
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = [...recent].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.openedAt - a.openedAt);
    return q ? list.filter((r) => r.name.toLowerCase().includes(q) || r.path.toLowerCase().includes(q)) : list;
  }, [recent, filter]);
  const update = useAppState((s) => s.updateProfile);
  const open = async (path: string) => {
    setError(null);
    setFailedRecent(null);
    await openPathInTab(path, tab.id);
    // A folder that isn't in a repository leaves this tab on the Open screen with the error.
    const err = useRuntime.getState().tabs[tab.id]?.error;
    if (err) {
      setError(err);
      setFailedRecent(useAppState.getState().profile.recent.some((r) => r.path === path) ? path : null);
    }
  };

  return (
    <div className="open-screen">
      {!reposFolder && <ReposFolderBanner />}
      {error && (
        <p className="open-error" role="alert">
          {error}
          {failedRecent && <button type="button" className="open-btn" onClick={() => { update((p) => removeRecent(p, failedRecent)); setError(null); setFailedRecent(null); }}>Remove from recent</button>}
        </p>
      )}
      <div className="open-grid">
        <section className="open-section" aria-labelledby="open-recent">
          <h2 id="open-recent">Recent</h2>
          <input className="open-filter" placeholder="Filter recent repositories" aria-label="Filter recent repositories" value={filter} onChange={(e) => setFilter(e.target.value)} spellCheck={false} />
          <div className="open-scroll">
          {shown.length === 0 ? <p className="dim">{recent.length === 0 ? 'Repositories you open appear here.' : 'No recent repository matches.'}</p> : (
            <ul className="open-list">
              {shown.map((r) => (
                <li key={r.path} className="open-recent-item">
                  <button type="button" className="open-row" onClick={() => void open(r.path)} title={r.path}>
                    <span className="open-name">{r.name}</span>
                    <span className="dim open-path">{r.path}</span>
                  </button>
                  <HoverTooltip content={r.pinned ? 'Unpin' : 'Pin to the top'}>
                    <button type="button" className="open-icon-btn" aria-label={`${r.pinned ? 'Unpin' : 'Pin'} ${r.name}`} aria-pressed={r.pinned} onClick={() => update((p) => togglePinRecent(p, r.path))}>
                      {r.pinned ? <PinOff size={13} /> : <Pin size={13} />}
                    </button>
                  </HoverTooltip>
                  <HoverTooltip content="Remove from recent (the repository is untouched)">
                    <button type="button" className="open-icon-btn" aria-label={`Remove ${r.name} from recent`} onClick={() => update((p) => removeRecent(p, r.path))}><X size={13} /></button>
                  </HoverTooltip>
                </li>
              ))}
            </ul>
          )}
          </div>
        </section>
        <div className="open-col">
        <section className="open-section" aria-labelledby="open-folder">
          <h2 id="open-folder">Open</h2>
          <button
            type="button"
            className="open-btn primary"
            onClick={async () => {
              try {
                const picked = await api.pickFolder(reposFolder);
                if (picked) await open(picked);
              } catch (e) {
                setError(errorMessage(e));
              }
            }}
          >
            <FolderOpen size={14} /> Open folder…
          </button>
          <p className="dim">Any folder inside a repository opens that repository; a linked worktree opens as its own tab.</p>
        </section>
        <section className="open-section" aria-labelledby="open-clone">
          <h2 id="open-clone">Clone</h2>
          <CloneForm tabId={tab.id} autoFocus={focusClone} />
        </section>
        </div>
        <YourRepos folders={folders} onOpen={(p) => void open(p)} />
      </div>
    </div>
  );
}
