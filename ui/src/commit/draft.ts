import { useCallback } from 'react';
import { create } from 'zustand';

/**
 * The WIP draft (spec #2 §8.2): one value per repo + worktree, shown in two places, the WIP row's
 * summary box and the commit box. Typing in either updates both (this store). It's persisted
 * across restarts under one localStorage key, written debounced and flushed on `pagehide`. It
 * isn't per branch. Every storage access is best-effort: blocked storage keeps drafts in memory.
 */
export interface WipDraft { summary: string; description: string }

export const EMPTY_DRAFT: WipDraft = Object.freeze({ summary: '', description: '' });
/** The summary counter shows past this many characters… */
export const WIP_DRAFT_COUNTER_FROM = 60;
/** …and turns to the warning colour past this many. Longer is allowed: nothing is truncated. */
export const WIP_DRAFT_WARN_FROM = 72;
export const DRAFT_STORAGE_KEY = 'gitbolt.wipDraft.v2';
const V1_PREFIX = 'gitbolt.wipDraft.v1:';
const BODY_V1_PREFIX = 'gitbolt.wipBody.v1:';
const PERSIST_MS = 300;

/** The draft's key: the tab's repo path and the worktree path (the v1 key's suffix too). */
export const draftKey = (repoPath: string, worktree: string) => `${repoPath}\u0000${worktree}`;

const lf = (s: string) => s.replace(/\r\n?/g, '\n');
const isEmpty = (d: WipDraft) => !d.summary && !d.description;

/** `\r\n` and `\r` become `\n`; the description's leading blank lines go. */
export function normalizeDraft(d: WipDraft): WipDraft {
  return { summary: lf(d.summary), description: lf(d.description).replace(/^(?:[ \t]*\n)+/, '') };
}

/** A whole message (HEAD's, MERGE_MSG) as the two fields. */
export function splitMessage(message: string): WipDraft {
  const text = lf(message).replace(/\n+$/, '');
  const i = text.indexOf('\n');
  return normalizeDraft(i < 0 ? { summary: text, description: '' } : { summary: text.slice(0, i), description: text.slice(i + 1) });
}

/** The commit or stash message: the summary, plus a blank line and the description when there is one. */
export function draftMessage(d: WipDraft): string {
  return d.description.trim() ? `${d.summary}\n\n${d.description}` : d.summary;
}

/** §8.2 "Merge stops on conflicts" (2D calls it): MERGE_MSG below any description, the summary
 * kept; an empty summary takes MERGE_MSG's first line and the description the rest. */
export function withMergeMessage(d: WipDraft, mergeMsg: string): WipDraft {
  const m = splitMessage(mergeMsg);
  const join = (...parts: string[]) => parts.filter((p) => p.trim()).join('\n\n');
  return d.summary.trim()
    ? { summary: d.summary, description: join(d.description, draftMessage(m)) }
    : { summary: m.summary, description: join(d.description, m.description) };
}

function storage(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

const isDraft = (v: unknown): v is WipDraft =>
  !!v && typeof v === 'object' && typeof (v as WipDraft).summary === 'string' && typeof (v as WipDraft).description === 'string';

/** The v2 map, with any v1 summary or body moved into it (a v2 field already set wins). Malformed
 * entries are ignored one by one. The v1 keys go only after the v2 write succeeds. */
function readAll(): Record<string, WipDraft> {
  const ls = storage();
  if (!ls) return {};
  const all: Record<string, WipDraft> = {};
  try {
    const raw: unknown = JSON.parse(ls.getItem(DRAFT_STORAGE_KEY) ?? '{}');
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [k, v] of Object.entries(raw)) if (isDraft(v)) all[k] = { summary: v.summary, description: v.description };
    }
  } catch {
    /* unreadable: start empty */
  }
  try {
    const old: string[] = [];
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i);
      if (k?.startsWith(V1_PREFIX) || k?.startsWith(BODY_V1_PREFIX)) old.push(k);
    }
    for (const k of old) {
      const body = k.startsWith(BODY_V1_PREFIX);
      const id = k.slice((body ? BODY_V1_PREFIX : V1_PREFIX).length);
      const value = ls.getItem(k) ?? '';
      const cur = all[id] ?? EMPTY_DRAFT;
      if (body ? !cur.description : !cur.summary) all[id] = normalizeDraft(body ? { ...cur, description: value } : { ...cur, summary: value });
    }
    if (old.length) {
      ls.setItem(DRAFT_STORAGE_KEY, JSON.stringify(all));
      for (const k of old) ls.removeItem(k);
    }
  } catch {
    /* blocked or over quota: the v1 keys stay for the next start */
  }
  return all;
}

interface DraftState {
  drafts: Record<string, WipDraft>;
  set(key: string, d: WipDraft): void;
}

let timer: ReturnType<typeof setTimeout> | null = null;

/** Writes the drafts now (blur, Enter/Esc in a box, `pagehide`). */
export function flushDrafts(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  try {
    storage()?.setItem(DRAFT_STORAGE_KEY, JSON.stringify(useWipDrafts.getState().drafts));
  } catch {
    /* storage unavailable: the drafts live as long as the app */
  }
}

export const useWipDrafts = create<DraftState>((set) => ({
  drafts: readAll(),
  set: (key, d) => {
    set((s) => {
      const drafts = { ...s.drafts };
      if (isEmpty(d)) delete drafts[key];
      else drafts[key] = d;
      return { drafts };
    });
    timer ??= setTimeout(flushDrafts, PERSIST_MS);
  },
}));

if (typeof window !== 'undefined') window.addEventListener('pagehide', flushDrafts);

/** Tests: read storage again (after seeding v1 keys). */
export function reloadDrafts(): void {
  useWipDrafts.setState({ drafts: readAll() });
}

export const readWipDraft = (repoPath: string, worktree: string): WipDraft => useWipDrafts.getState().drafts[draftKey(repoPath, worktree)] ?? EMPTY_DRAFT;
export const writeWipDraft = (repoPath: string, worktree: string, d: WipDraft): void => useWipDrafts.getState().set(draftKey(repoPath, worktree), d);
export const clearWipDraft = (repoPath: string, worktree: string): void => writeWipDraft(repoPath, worktree, EMPTY_DRAFT);

/** The draft of one worktree, live: both boxes re-render on a keystroke in either. */
export function useWipDraft(repoPath: string, worktree: string): [WipDraft, (d: WipDraft) => void] {
  const key = draftKey(repoPath, worktree);
  const draft = useWipDrafts((s) => s.drafts[key]) ?? EMPTY_DRAFT;
  const set = useCallback((d: WipDraft) => useWipDrafts.getState().set(key, d), [key]);
  return [draft, set];
}

/** 2C T2: a linked worktree's tab used to key its drafts by its own path; one handle per
 * repository keys them by the repository's. Moves every `from` draft to `to`, worktree kept, so
 * an unsent message is never lost; a draft already under `to` wins, and the old one then stays
 * where it was. */
export function rekeyWipDrafts(from: string, to: string): void {
  if (from === to) return;
  const prefix = `${from}\u0000`;
  const { drafts } = useWipDrafts.getState();
  const moving = Object.keys(drafts).filter((k) => k.startsWith(prefix));
  if (!moving.length) return;
  const next = { ...drafts };
  let moved = false;
  for (const k of moving) {
    const target = draftKey(to, k.slice(prefix.length));
    if (next[target]) continue;
    next[target] = next[k];
    delete next[k];
    moved = true;
  }
  if (!moved) return;
  useWipDrafts.setState({ drafts: next });
  flushDrafts();
}

/** §8.2: drafts whose worktree no longer exists go when the worktree list loads. */
export function pruneWipDrafts(repoPath: string, worktrees: readonly string[]): void {
  // Only a complete list prunes; the main worktree (the repo path) is never dropped.
  if (!worktrees.length) return;
  const keep = new Set([repoPath, ...worktrees].map((w) => draftKey(repoPath, w)));
  const prefix = `${repoPath}\u0000`;
  const { drafts } = useWipDrafts.getState();
  const gone = Object.keys(drafts).filter((k) => k.startsWith(prefix) && !keep.has(k));
  if (!gone.length) return;
  const next = { ...drafts };
  for (const k of gone) delete next[k];
  useWipDrafts.setState({ drafts: next });
  flushDrafts();
}
