import { createContext, useContext } from 'react';
import type { RepoInfoPayload } from '../api/gen/RepoInfoPayload';

/** The repo tab a component renders in (`RepoTab` provides it). Outside a tab: `tabId` is ''.
 * `path` is the repository's (its settings key); `worktree` is the tab's active worktree (spec #2
 * §11.2), what writes target. */
export interface RepoCtx { tabId: string; repoId: number; path: string; worktree: string; info: RepoInfoPayload | null }
export const RepoContext = createContext<RepoCtx>({ tabId: '', repoId: -1, path: '', worktree: '', info: null });
export const useRepoContext = () => useContext(RepoContext);
