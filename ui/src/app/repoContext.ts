import { createContext, useContext } from 'react';
import type { RepoInfoPayload } from '../api/gen/RepoInfoPayload';

/** The repo tab a component renders in (`RepoTab` provides it). Outside a tab: `tabId` is ''. */
export interface RepoCtx { tabId: string; repoId: number; path: string; info: RepoInfoPayload | null }
export const RepoContext = createContext<RepoCtx>({ tabId: '', repoId: -1, path: '', info: null });
export const useRepoContext = () => useContext(RepoContext);
