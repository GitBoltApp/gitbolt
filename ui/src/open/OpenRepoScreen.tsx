import { ArrowDownAZ, Clock, FolderOpen, FolderTree, GitBranch, List, Pin, PinOff, Plus, RefreshCw, TreePine, X } from 'lucide-react';
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { api, errorMessage } from '../api/client';
import type { ScannedRepo } from '../api/gen/ScannedRepo';
import type { TabState } from '../api/gen/TabState';
import { useAppInfo, useTilde } from '../app/appInfo';
import { openPathInTab, useRuntime } from '../app/runtime';
import { useAppState } from '../app/state';
import { removeRecent, togglePinRecent } from '../app/tabs';
import { relativeTime } from '../format/relative';
import { HoverTooltip } from '../ui/HoverTooltip';
import { CloneForm } from './CloneForm';
import { folderLabels, folderOf } from './folderLabels';
import { useOpenUi } from './openUi';
import './open.css';

function ReposFolderBanner() {
  const [suggestion, setSuggestion] = useState<string | null>(null);
  useEffect(() => { void api.suggestReposFolder().then(setSuggestion, () => undefined); }, []);
  const [error, setError] = useState<string | null>(null);
  const tilde = useTilde();
  const set = (p: string) => useAppState.getState().updateProfile((prof) => {
    const folders = prof.reposFolders ?? [];
    return { ...prof, reposFolder: p, reposFolders: folders.includes(p) ? folders : [...folders, p] };
  });
  return (
    <div className="open-banner" role="region" aria-label="Default repos directory">
      <span>Set a default repos directory: it's where clones go (and “Your repos” scans it).</span>
      {suggestion && <button type="button" className="open-btn primary" onClick={() => set(suggestion)}>Use {tilde(suggestion)}</button>}
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

/** "Your repos" order, most recently changed first (the scan's own order, the default) or A–Z,
 *  and layout, one list (the default) or a list under each directory; both remembered. */
type Order = 'recent' | 'alpha';
type Layout = 'merged' | 'grouped';
const ORDER_KEY = 'gitbolt.yourReposOrder.v1';
const LAYOUT_KEY = 'gitbolt.yourReposLayout.v1';
function loadPref<T extends string>(key: string, other: T, fallback: T): T {
  try {
    return localStorage.getItem(key) === other ? other : fallback;
  } catch {
    return fallback;
  }
}
function savePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* a private window: the choice just isn't remembered */
  }
}
const byName = (a: ScannedRepo, b: ScannedRepo) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.path.localeCompare(b.path);

/** "Your repos": every folder in the profile's list, merged or grouped by folder. Only the list scrolls. */
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
  const [filter, setFilter] = useState('');
  const [order, setOrder] = useState<Order>(() => loadPref<Order>(ORDER_KEY, 'alpha', 'recent'));
  const [layout, setLayout] = useState<Layout>(() => loadPref<Layout>(LAYOUT_KEY, 'grouped', 'merged'));
  const shown = useMemo(() => {
    if (!repos) return null;
    const q = filter.trim().toLowerCase();
    const list = q ? repos.filter((r) => r.name.toLowerCase().includes(q) || r.path.toLowerCase().includes(q)) : repos;
    return order === 'alpha' ? [...list].sort(byName) : list;
  }, [repos, filter, order]);
  // Grouping only means something with more than one directory.
  const grouped = layout === 'grouped' && folders.length > 1;
  // In one list with more than one directory scanned, each row says which one it came from.
  const labels = useMemo(() => (folders.length > 1 ? folderLabels(folders) : null), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const groups = useMemo(() => {
    const by = new Map<string, ScannedRepo[]>(folders.map((f) => [f, []]));
    for (const r of shown ?? []) by.get(folderOf(r.path, folders) ?? '')?.push(r);
    return by;
  }, [shown, key]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggleOrder = () => setOrder((o) => { const next: Order = o === 'alpha' ? 'recent' : 'alpha'; savePref(ORDER_KEY, next); return next; });
  const toggleLayout = () => setLayout((l) => { const next: Layout = l === 'grouped' ? 'merged' : 'grouped'; savePref(LAYOUT_KEY, next); return next; });
  const update = useAppState((s) => s.updateProfile);
  const tilde = useTilde();
  const setFolders = (next: string[]) => update((p) => ({ ...p, reposFolders: next }));
  const add = async () => {
    try {
      const picked = await api.pickFolder(folders[folders.length - 1] ?? null);
      if (picked && !folders.some((f) => sameFolder(f, picked))) setFolders([...folders, picked]);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const chip = (f: string) => (
    <>
      <HoverTooltip content={f}><span className="dim open-folder-path">{tilde(f)}</span></HoverTooltip>
      <HoverTooltip content="Stop scanning this directory">
        <button type="button" className="open-icon-btn" aria-label={`Remove directory ${f}`} onClick={() => setFolders(folders.filter((x) => x !== f))}><X size={12} /></button>
      </HoverTooltip>
    </>
  );
  const rows = (list: ScannedRepo[], tagged: boolean) => (
    <ul className="open-list">
      {list.map((r) => (
        <li key={r.path}>
          <HoverTooltip content={<>{r.path}{r.worktreeOf && <><br />Worktree of {r.worktreeOf}</>}<br />{r.branch ? `On ${r.branch}` : 'Detached HEAD'}</>}>
          <button type="button" className="open-row" onClick={() => onOpen(r.path)} aria-description={r.worktreeOf ? `worktree of ${r.worktreeOf}` : undefined}>
            <span className="open-name">{r.worktreeOf && <TreePine size={12} className="open-wt-icon" aria-hidden />}{r.name}</span>
            {tagged && labels && <span className="dim open-from">{labels.get(folderOf(r.path, folders) ?? '')}</span>}
            <span className="dim open-branch"><GitBranch size={11} /> {r.branch ?? 'detached'}</span>
            <span className="dim open-when">{relativeTime(r.modified)}</span>
          </button>
          </HoverTooltip>
        </li>
      ))}
    </ul>
  );
  const scanning = repos === null || shown === null;
  // A "Clone from forge" entry would sit next to the + (K90, needs forge tokens).
  return (
    <section className="open-section open-yours" aria-labelledby="open-yours">
      <h2 id="open-yours">Your repos
        <HoverTooltip content="Scan the directories again"><button type="button" className="open-icon-btn" aria-label="Refresh" onClick={() => load(true)}><RefreshCw size={13} /></button></HoverTooltip>
        <HoverTooltip content="Add a directory to scan"><button type="button" className="open-icon-btn" aria-label="Add directory" onClick={() => void add()}><Plus size={14} /></button></HoverTooltip>
        {folders.length > 1 && (
          <HoverTooltip content={grouped ? 'Grouped by directory: switch to one list' : 'One list: switch to grouped by directory'}>
            <button type="button" className="open-icon-btn open-push" aria-label={grouped ? 'Show as one list' : 'Group by directory'} onClick={toggleLayout}>{grouped ? <FolderTree size={14} /> : <List size={14} />}</button>
          </HoverTooltip>
        )}
        <HoverTooltip content={order === 'alpha' ? 'Sorted A–Z: switch to most recently changed first' : 'Most recently changed first: switch to A–Z'}>
          <button type="button" className={`open-icon-btn${folders.length > 1 ? '' : ' open-push'}`} aria-label={order === 'alpha' ? 'Sort by most recently changed' : 'Sort A–Z'} onClick={toggleOrder}>{order === 'alpha' ? <ArrowDownAZ size={14} /> : <Clock size={13} />}</button>
        </HoverTooltip>
      </h2>
      {folders.length > 0 && <input className="open-filter" placeholder="Filter your repositories" aria-label="Filter your repositories" value={filter} onChange={(e) => setFilter(e.target.value)} spellCheck={false} />}
      {!grouped && (
        <ul className="open-folders" aria-label="Scanned directories">
          {folders.map((f) => <li key={f} className="open-folder-chip">{chip(f)}</li>)}
        </ul>
      )}
      {error && <p className="open-error" role="alert">Couldn't scan: {error}</p>}
      <div className={`open-scroll${grouped ? ' open-grouped' : ''}`}>
        {folders.length === 0 ? <p className="dim">Add a directory with + and its repositories are listed here.</p> : grouped ? (
          <ul className="open-groups" aria-label="Scanned directories">
            {folders.map((f) => {
              const list = groups.get(f) ?? [];
              return (
                // Each directory gets an even share of the height, or just what its rows need (open.css).
                <li key={f} className="open-group" style={{ '--rows': Math.max(list.length, 1) } as CSSProperties}>
                  <div className="open-folder-chip">{chip(f)}</div>
                  {scanning ? null : list.length ? rows(list, false) : <p className="dim open-group-empty">{filter.trim() ? 'No repository matches.' : 'No repositories found two levels deep.'}</p>}
                </li>
              );
            })}
          </ul>
        ) : scanning ? <p className="dim">Scanning…</p> : repos.length === 0 ? (error ? null : <p className="dim">No repositories found two levels deep.</p>) : shown.length === 0 ? <p className="dim">No repository matches.</p> : rows(shown, true)}
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
  // The home folder, for showing paths as ~/…
  useEffect(() => { void useAppInfo.getState().load().catch(() => undefined); }, []);
  const tilde = useTilde();
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
                  <HoverTooltip content={r.path}>
                    <button type="button" className="open-row" onClick={() => void open(r.path)}>
                      <span className="open-name">{r.name}</span>
                      <span className="dim open-path">{tilde(r.path)}</span>
                    </button>
                  </HoverTooltip>
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
            <FolderOpen size={14} /> Open directory…
          </button>
          <p className="dim">Any directory inside a repository opens that repository; a linked worktree opens as its own tab.</p>
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
