import { create } from 'zustand';
import type { ForgeUser } from '../../api/gen/ForgeUser';

/**
 * Resumable Create MR/PR drafts (spec #4 §2 "Create MR/PR"): one per repo + source branch, kept
 * across restarts until the MR/PR is created or the draft discarded. As the WIP drafts
 * (commit/draft.ts): one localStorage key, written after a short pause and at once on `pagehide`,
 * every storage access best-effort (blocked or full storage keeps drafts in memory). A draft
 * exists only once the user changed something (ruling 8): an untouched prefill is computed again
 * on every open.
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

/** Every well-formed draft in storage; a malformed entry is dropped on its own. */
function readAll(): Record<string, MrDraft> {
  const all: Record<string, MrDraft> = {};
  try {
    const raw: unknown = JSON.parse(storage()?.getItem(MR_DRAFT_STORAGE_KEY) ?? '{}');
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [k, v] of Object.entries(raw)) if (isMrDraft(v)) all[k] = slimDraft(v);
    }
  } catch {
    /* unreadable: start empty */
  }
  return all;
}

interface DraftState {
  drafts: Record<string, MrDraft>;
  set(key: string, d: MrDraft | null): void;
}

let timer: ReturnType<typeof setTimeout> | null = null;

/** Writes the drafts now (blur, closing the flyout, `pagehide`). */
export function flushMrDrafts(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  try {
    storage()?.setItem(MR_DRAFT_STORAGE_KEY, JSON.stringify(Object.fromEntries(Object.entries(useMrDrafts.getState().drafts).map(([k, d]) => [k, slimDraft(d)]))));
  } catch {
    /* storage unavailable or full: the drafts live as long as the app */
  }
}

export const useMrDrafts = create<DraftState>((set) => ({
  drafts: readAll(),
  set: (key, d) => {
    set((s) => {
      const drafts = { ...s.drafts };
      if (d) drafts[key] = d;
      else delete drafts[key];
      return { drafts };
    });
    timer ??= setTimeout(flushMrDrafts, PERSIST_MS);
  },
}));

if (typeof window !== 'undefined') window.addEventListener('pagehide', flushMrDrafts);

/** Tests: read storage again. */
export function reloadMrDrafts(): void {
  useMrDrafts.setState({ drafts: readAll() });
}

export const readMrDraft = (repoPath: string, branch: string): MrDraft | null => useMrDrafts.getState().drafts[mrDraftKey(repoPath, branch)] ?? null;
export const writeMrDraft = (repoPath: string, branch: string, d: MrDraft): void => useMrDrafts.getState().set(mrDraftKey(repoPath, branch), d);
/** Created or discarded: gone from storage at once. */
export function discardMrDraft(repoPath: string, branch: string): void {
  useMrDrafts.getState().set(mrDraftKey(repoPath, branch), null);
  flushMrDrafts();
}
