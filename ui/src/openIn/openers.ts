import { useCallback, useEffect } from 'react';
import { create } from 'zustand';
import { api, errorMessage } from '../api/client';
import type { BlobSource } from '../api/gen/BlobSource';
import type { DiffSpec } from '../api/gen/DiffSpec';
import type { OpenerPayload } from '../api/gen/OpenerPayload';
import { useRepoView, type DiffTarget } from '../repo/store';
import { useToast } from '../ui/toast';
import { useRuntime } from '../app/runtime';
import { useAppState } from '../app/state';
import { configuredOpenerId } from './configuredOpener';
import { loadLastOpener, saveLastOpener } from './openInPrefs';

/** What "Open in…" opens: `path` in `worktree` (one of the repo's), at a 1-based `line`, in
 * the version `source` (a stored one opens as a read-only copy; spec §14.5), or `fallback` when
 * `source` is the working-tree file and it's gone. */
export interface OpenInTarget { worktree: string; path: string; line: number | null; source: BlobSource | null; fallback: BlobSource | null }

/**
 * The machine's openers, shared by every "Open in…" control: `list` is the last one loaded
 * (`null` before the first), `error` the last load's failure. Loaded on first use and again each
 * time a menu opens (H32; the backend caches its detection briefly), so an editor installed
 * since shows up. A failed load keeps the last list and is retried on the next opening.
 */
const useOpenersStore = create<{ list: OpenerPayload[] | null; error: string | null }>(() => ({ list: null, error: null }));
let inflight: Promise<OpenerPayload[]> | undefined;

/** Loads the openers again (one request at a time). */
export function refreshOpeners(): Promise<OpenerPayload[]> {
  // Through a promise, so a transport that throws (none, in unit tests) rejects instead.
  return (inflight ??= Promise.resolve()
    .then(() => {
      // The shown repo's view of the list: its own Custom editor setting decides the `custom` entry.
      const tab = useAppState.getState().profile.activeTab;
      const repo = tab ? useRuntime.getState().tabs[tab]?.repo?.id : undefined;
      return repo === undefined ? api.listOpeners() : api.listOpeners(repo);
    })
    .then(
      (list) => {
        useOpenersStore.setState({ list, error: null });
        return list;
      },
      (e: unknown) => {
        useOpenersStore.setState({ error: errorMessage(e) });
        throw e;
      },
    )
    .finally(() => { inflight = undefined; }));
}

/** The openers, loading them if they never were. */
export function loadOpeners(): Promise<OpenerPayload[]> {
  const { list } = useOpenersStore.getState();
  return list ? Promise.resolve(list) : refreshOpeners();
}

/** The last opener used, shared by every "Open in…" control (the file list's menu and the diff
 * header's button show the same default). */
const useLastOpener = create<{ last: string | null }>(() => ({ last: loadLastOpener() }));

export function resetOpenersForTests() {
  inflight = undefined;
  useOpenersStore.setState({ list: null, error: null });
  useLastOpener.setState({ last: loadLastOpener() });
}

/** The openers, or `null` until they've loaded (loading them on first use). */
export function useOpeners(): OpenerPayload[] | null {
  useEffect(() => { loadOpeners().catch(() => {}); }, []);
  return useOpenersStore((s) => s.list);
}

export { defaultOpener, openerLabel } from './openerRows';

/** What a menu builder reads, synchronously: the openers (null before the first load), the last
 * load's error, and the last opener used (the default). */
export function openersSnapshot(): { list: OpenerPayload[] | null; error: string | null; last: string | null } {
  const { list, error } = useOpenersStore.getState();
  return { list, error, last: configuredOpenerId(useAppState.getState().profile) ?? useLastOpener.getState().last };
}

/** Calls `fn` whenever the openers or the last used one change (an open menu rebuilds). */
export function subscribeOpeners(fn: () => void): () => void {
  const a = useOpenersStore.subscribe(fn);
  const b = useLastOpener.subscribe(fn);
  const c = useAppState.subscribe((s, prev) => { if (s.profile.editor !== prev.profile.editor || s.profile.repos !== prev.profile.repos || s.profile.activeTab !== prev.profile.activeTab) fn(); });
  return () => { a(); b(); c(); };
}

const stored = (b: BlobSource) => b.kind === 'object' || b.kind === 'atCommit';

/**
 * The version "Open in…" opens (fix rounds 1, 2). In a worktree list (WIP unstaged or staged,
 * compare with the working tree): the working-tree file itself, which is what gets edited;
 * if it's gone from the working tree, the list's stored version (the index).
 * Elsewhere: the version shown, the new side, or a deleted file's old side.
 */
export function openVersion(t: DiffTarget, worktree: string | null): { source: BlobSource; fallback: BlobSource | null } {
  if (worktree) return { source: { kind: 'worktree', worktree }, fallback: [t.new, t.old].find(stored) ?? null };
  return { source: t.new.kind === 'absent' ? t.old : t.new, fallback: null };
}

/** The `DiffSpec` a list-item key starts with (`filesKey(spec)`, the spec's JSON, followed by
 * `|`): tried at each `}|` boundary, since a worktree path inside the spec can itself contain
 * `}|`. `null` if none parses (a malformed key). Shared by `listWorktree` and the Monaco menu's
 * `menuEnv.monacoTargetOf` (plan 1C Task 15), which both need the list a diff target came from. */
export function parseListSpec(key: string): DiffSpec | null {
  for (let i = key.indexOf('}|'); i >= 0; i = key.indexOf('}|', i + 1)) {
    try {
      return JSON.parse(key.slice(0, i + 1)) as DiffSpec;
    } catch {
      // A `}|` inside the spec (a worktree path): keep looking.
    }
  }
  return null;
}

/** The worktree of the list a target came from (its key starts with the list's `filesKey`, the
 * spec's JSON): a WIP or compare-with-working-tree list's, else `null`. A staged file has no
 * worktree side, so this is how the diff header knows its worktree. */
export function listWorktree(key: string): string | null {
  const spec = parseListSpec(key);
  return spec && (spec.kind === 'wip' || spec.kind === 'worktree') ? spec.worktree : null;
}

/** The worktree a diff side reads from, if either does (WIP, compare with the working tree). */
export function worktreeOf(t: DiffTarget): string | null {
  if (t.new.kind === 'worktree') return t.new.worktree;
  if (t.old.kind === 'worktree') return t.old.worktree;
  return null;
}

/** The default opener (the one Settings chose, else the last used), and `open(opener, target)`, which remembers it and
 * shows a failure as a toast. */
export function useOpenIn() {
  const repo = useRepoView((s) => s.repo);
  const toast = useToast((s) => s.show);
  const lastUsed = useLastOpener((s) => s.last);
  const configured = useAppState((s) => configuredOpenerId(s.profile));
  const last = configured ?? lastUsed;
  const open = useCallback((opener: OpenerPayload, t: OpenInTarget) => openWith(repo, opener, t, toast), [repo, toast]);
  return { last, open };
}

/** Opens `t` in repo `repo` with `opener`, remembering it as the default; a failure shows as a
 * toast. Shared by the Open in button and the file menu. */
export function openWith(repo: number, opener: OpenerPayload, t: OpenInTarget, toast: (m: string) => void = (m) => useToast.getState().show(m)): void {
  saveLastOpener(opener.id);
  useLastOpener.setState({ last: opener.id });
  api.openIn(repo, { worktree: t.worktree, path: t.path, line: t.line, opener: opener.id, source: t.source, fallback: t.fallback }).catch((e: unknown) => toast(errorMessage(e)));
}
