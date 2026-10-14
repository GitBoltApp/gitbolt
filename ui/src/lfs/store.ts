import { useEffect } from 'react';
import { create } from 'zustand';
import { api } from '../api/client';
import type { AppEvent } from '../api/gen/AppEvent';
import type { LfsStatusPayload } from '../api/gen/LfsStatusPayload';
import { useTabViews } from '../app/tabStores';

/**
 * Git LFS per repository: whether it's used and git-lfs's version (`lfsStatus`, read once per
 * repository opened, and again after a Track), and which file-list paths LFS stores (`lfsTracked`,
 * looked up in batches as rows show, only in a repository that uses LFS). `epoch` moves after a
 * download, so the diff views read their contents again (`useContents`).
 */
interface LfsState {
  status: Record<number, LfsStatusPayload | undefined>;
  /** `${repo}|${worktree}` → path → stored with LFS. */
  tracked: Record<string, Record<string, boolean> | undefined>;
  epoch: number;
}

/** git-lfs is installed but `git lfs install` wasn't run for this repository. */
export const NOT_SET_UP = "git-lfs isn't set up in this repository, so the files stay pointers: run git lfs install";
export const INSTALL_COMMAND = 'git lfs install';

export const useLfs = create<LfsState>(() => ({ status: {}, tracked: {}, epoch: 0 }));

const loading = new Map<number, Promise<void>>();
/** Repositories whose read failed: not asked again until `force`. */
const failed = new Set<number>();

/** Reads repo `repo`'s LFS status, once (`force`: again). A failure leaves it unknown, so
 * nothing about LFS shows. */
export function loadLfsStatus(repo: number, force = false, recheck = false): Promise<void> {
  const running = loading.get(repo);
  if (running && !force) return running;
  if (!force && (useLfs.getState().status[repo] || failed.has(repo))) return Promise.resolve();
  failed.delete(repo);
  const p = Promise.resolve().then(() => (recheck ? api.lfsStatus(repo, true) : api.lfsStatus(repo))).then(
    (s) => useLfs.setState((st) => ({ status: { ...st.status, [repo]: s } })),
    (e: unknown) => {
      failed.add(repo);
      console.warn('[gitvolt] LFS status', e);
    },
  );
  loading.set(repo, p);
  return p.finally(() => { if (loading.get(repo) === p) loading.delete(repo); });
}

/** Repo `repo`'s LFS status as known now (`undefined`: not read yet, and its read starts). */
export function lfsStatusOf(repo: number): LfsStatusPayload | undefined {
  const s = useLfs.getState().status[repo];
  if (!s && repo >= 0) void loadLfsStatus(repo);
  return s;
}

export function useLfsStatus(repo: number): LfsStatusPayload | undefined {
  const s = useLfs((st) => st.status[repo]);
  useEffect(() => { if (!s && repo >= 0) void loadLfsStatus(repo); }, [s, repo]);
  return s;
}

const trackedKey = (repo: number, worktree: string) => `${repo}|${worktree}`;

/** Paths waiting for one batched `lfsTracked`, per repository and worktree. */
const queued = new Map<string, { repo: number; worktree: string; paths: Set<string> }>();
let flushing = false;

function flush() {
  flushing = false;
  const batches = [...queued.values()];
  queued.clear();
  for (const { repo, worktree, paths } of batches) {
    const asked = [...paths];
    Promise.resolve().then(() => api.lfsTracked(repo, worktree, asked)).then(
      (found) => {
        const yes = new Set(found);
        const key = trackedKey(repo, worktree);
        useLfs.setState((st) => ({ tracked: { ...st.tracked, [key]: { ...st.tracked[key], ...Object.fromEntries(asked.map((p) => [p, yes.has(p)])) } } }));
      },
      (e: unknown) => console.warn('[gitvolt] LFS paths', e),
    );
  }
}

function ask(repo: number, worktree: string, path: string) {
  const key = trackedKey(repo, worktree);
  const batch = queued.get(key) ?? { repo, worktree, paths: new Set<string>() };
  if (batch.paths.has(path)) return;
  batch.paths.add(path);
  queued.set(key, batch);
  if (!flushing) {
    flushing = true;
    queueMicrotask(flush);
  }
}

/** Whether LFS stores `path` (as known; `undefined`: not known yet). */
export const trackedOf = (repo: number, worktree: string, path: string): boolean | undefined => useLfs.getState().tracked[trackedKey(repo, worktree)]?.[path];

/** Whether LFS stores `path`: `false` until known, and always in a repository that doesn't use
 * LFS (nothing is asked then). */
export function useLfsTracked(repo: number, worktree: string, path: string): boolean {
  const used = useLfsStatus(repo)?.used ?? false;
  const known = useLfs((st) => st.tracked[trackedKey(repo, worktree)]?.[path]);
  useEffect(() => { if (used && known === undefined && worktree) ask(repo, worktree, path); }, [used, known, repo, worktree, path]);
  return used && known === true;
}

/** Repo `repo`'s status and every path known for it, read again (after Track or Stop tracking, a
 * checkout, a pull, an edit of `.gitattributes`). The known answers stay shown meanwhile.
 * `recheck`: git-lfs's version too (the core keeps it for the session). */
export function refreshLfs(repo: number, recheck = false): Promise<void> {
  const prefix = `${repo}|`;
  for (const [key, paths] of Object.entries(useLfs.getState().tracked)) {
    if (!key.startsWith(prefix) || !paths) continue;
    for (const p of Object.keys(paths)) ask(repo, key.slice(prefix.length), p);
  }
  return loadLfsStatus(repo, true, recheck);
}

/** How long a burst of changes settles before `refreshLfs`. */
export const REFRESH_MS = 1000;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

const rechecks = new Set<number>();

function refreshSoon(repo: number, recheck = false) {
  if (recheck) rechecks.add(repo);
  clearTimeout(timers.get(repo));
  timers.set(repo, setTimeout(() => {
    timers.delete(repo);
    void refreshLfs(repo, rechecks.delete(repo));
  }, REFRESH_MS));
}

/** A repository that uses LFS changed on disk (a checkout, a pull, `.gitattributes`, `git lfs
 * install`'s config), or an LFS, pull or checkout write finished: its LFS facts are read again,
 * once things settle (the index and attributes, cheap; git-lfs's version only after a failed LFS
 * write, which may mean git-lfs went away). */
export function onLfsEvent(ev: AppEvent): void {
  if (ev.type === 'repoChanged' && useLfs.getState().status[ev.repo]?.used) refreshSoon(ev.repo);
  else if (ev.type === 'opFinished' && ev.repo !== null && (ev.kind === 'lfs' || ev.kind === 'pull' || ev.kind === 'checkout')) refreshSoon(ev.repo, ev.kind === 'lfs' && ev.outcome === 'failed');
}

/** git-lfs may have been installed meanwhile: on the window's focus, repositories read without it
 * are read again. */
export function onLfsFocus(): void {
  for (const [repo, s] of Object.entries(useLfs.getState().status)) if (s && !s.version) void loadLfsStatus(Number(repo), true, true);
}

/** After a download, fetch or pull: every tab's cached diff contents are dropped (an LFS side
 * that wasn't downloaded may be now), and the open views read theirs again. */
export function lfsDownloaded(): void {
  for (const v of Object.values(useTabViews.getState().views)) v.services.contents.cache.clear();
  useLfs.setState((st) => ({ epoch: st.epoch + 1 }));
}

export const useLfsEpoch = () => useLfs((st) => st.epoch);
