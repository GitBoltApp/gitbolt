import { create } from 'zustand';
import type { ForgeUser } from '../../api/gen/ForgeUser';

/**
 * Resumable Create MR/PR drafts (spec #4 §2 "Create MR/PR"): one per repo + source branch, kept
 * across restarts until the MR/PR is created or the draft discarded. As the WIP drafts
 * (commit/draft.ts): one localStorage key, written after a short pause and at once on `pagehide`,
 * every storage access best-effort (blocked or full storage keeps drafts in memory). A draft
 * exists only once the user changed something (ruling 8): an untouched prefill is computed again
 * on every open. Capped on write: at most `MAX_MR_DRAFTS`, none older than 90 days, the oldest
 * dropped first (each stored draft carries its `savedAt`).
 */
export interface MrDraft {
  sourceRemote: string;
  targetRemote: string;
  targetBranch: string;
  title: string;
  description: string;
  /** The description as the prefill or a template last wrote it: another template replaces it
   * silently only while the description still equals this. */
  prefilled: string;
  /** The applied template's path. */
  template: string | null;
  reviewers: ForgeUser[];
  assignees: ForgeUser[];
  labels: string[];
  draft: boolean;
  /** GitLab only; `null` on GitHub. */
  squash: boolean | null;
  deleteSourceBranch: boolean | null;
}

export const MR_DRAFT_STORAGE_KEY = 'gitbolt.mrDrafts.v1';
const PERSIST_MS = 300;
export const MAX_MR_DRAFTS = 50;
export const MR_DRAFT_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

export const mrDraftKey = (repoPath: string, branch: string) => `${repoPath}\u0000${branch}`;

function storage(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const isBoolOrNull = (v: unknown) => v === null || typeof v === 'boolean';
const isUser = (u: unknown): u is ForgeUser =>
  !!u && typeof u === 'object' && typeof (u as ForgeUser).id === 'number' && isStr((u as ForgeUser).username) && isStr((u as ForgeUser).name);

function isMrDraft(v: unknown): v is MrDraft {
  if (!v || typeof v !== 'object') return false;
  const d = v as Record<string, unknown>;
  return isStr(d.sourceRemote) && isStr(d.targetRemote) && isStr(d.targetBranch) && isStr(d.title) && isStr(d.description) && isStr(d.prefilled)
    && (d.template === null || isStr(d.template))
    && Array.isArray(d.reviewers) && d.reviewers.every(isUser) && Array.isArray(d.assignees) && d.assignees.every(isUser)
    && Array.isArray(d.labels) && d.labels.every(isStr) && typeof d.draft === 'boolean' && isBoolOrNull(d.squash) && isBoolOrNull(d.deleteSourceBranch);
}

/** Only what the flyout needs: no email address is persisted. */
const slim = (u: ForgeUser): ForgeUser => ({ ...u, email: null });
const slimDraft = (d: MrDraft): MrDraft => ({ ...d, reviewers: d.reviewers.map(slim), assignees: d.assignees.map(slim) });

interface Drafts {
  drafts: Record<string, MrDraft>;
  /** ms epoch of each draft's last write. */
  savedAt: Record<string, number>;
}

/** Every well-formed draft in storage; a malformed entry is dropped on its own. One stored
 * without a `savedAt` (an older build's) counts as saved now. */
function readAll(): Drafts {
  const all: Drafts = { drafts: {}, savedAt: {} };
  try {
    const raw: unknown = JSON.parse(storage()?.getItem(MR_DRAFT_STORAGE_KEY) ?? '{}');
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [k, v] of Object.entries(raw)) {
        if (!isMrDraft(v)) continue;
        const { savedAt, ...d } = v as MrDraft & { savedAt?: unknown };
        all.drafts[k] = slimDraft(d);
        all.savedAt[k] = typeof savedAt === 'number' ? savedAt : Date.now();
      }
    }
  } catch {
    /* unreadable: start empty */
  }
  return all;
}

/** Drops drafts older than `MR_DRAFT_MAX_AGE_MS`, then the oldest beyond `MAX_MR_DRAFTS`. */
function prune({ drafts, savedAt }: Drafts, now: number): void {
  const keys = Object.keys(drafts).sort((a, b) => (savedAt[a] ?? 0) - (savedAt[b] ?? 0));
  keys.forEach((k, i) => {
    if (now - (savedAt[k] ?? 0) > MR_DRAFT_MAX_AGE_MS || i < keys.length - MAX_MR_DRAFTS) {
      delete drafts[k];
      delete savedAt[k];
    }
  });
}

interface DraftState extends Drafts {
  set(key: string, d: MrDraft | null): void;
}

let timer: ReturnType<typeof setTimeout> | null = null;

/** Writes the drafts now (blur, closing the flyout, `pagehide`). */
export function flushMrDrafts(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  try {
    const { drafts, savedAt } = useMrDrafts.getState();
    storage()?.setItem(MR_DRAFT_STORAGE_KEY, JSON.stringify(Object.fromEntries(Object.entries(drafts).map(([k, d]) => [k, { ...slimDraft(d), savedAt: savedAt[k] ?? Date.now() }]))));
  } catch {
    /* storage unavailable or full: the drafts live as long as the app */
  }
}

export const useMrDrafts = create<DraftState>((set) => ({
  ...readAll(),
  set: (key, d) => {
    set((s) => {
      const next: Drafts = { drafts: { ...s.drafts }, savedAt: { ...s.savedAt } };
      if (d) {
        const now = Date.now();
        next.drafts[key] = d;
        next.savedAt[key] = now;
        prune(next, now);
      } else {
        delete next.drafts[key];
        delete next.savedAt[key];
      }
      return next;
    });
    timer ??= setTimeout(flushMrDrafts, PERSIST_MS);
  },
}));

if (typeof window !== 'undefined') window.addEventListener('pagehide', flushMrDrafts);

/** Tests: read storage again. */
export function reloadMrDrafts(): void {
  useMrDrafts.setState(readAll());
}

export const readMrDraft = (repoPath: string, branch: string): MrDraft | null => useMrDrafts.getState().drafts[mrDraftKey(repoPath, branch)] ?? null;
export const writeMrDraft = (repoPath: string, branch: string, d: MrDraft): void => useMrDrafts.getState().set(mrDraftKey(repoPath, branch), d);
/** Created or discarded: gone from storage at once. */
export function discardMrDraft(repoPath: string, branch: string): void {
  useMrDrafts.getState().set(mrDraftKey(repoPath, branch), null);
  flushMrDrafts();
}
