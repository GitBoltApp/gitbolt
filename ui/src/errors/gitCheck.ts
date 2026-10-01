import { create } from 'zustand';
import { api } from '../api/client';
import type { GbError } from '../api/gen/GbError';
import { isGbError } from './describe';

interface GitCheck { problem: GbError | null; check(): Promise<void>; retry(): Promise<void> }

/** The spawn failed because there is no git binary (ENOENT); any other Io says nothing about git itself. */
const gitNotFound = (e: GbError) => e.kind === 'Io' && /failed to run git:.*(no such file|not found|os error 2)/i.test(e.message);

/** git is too old (GitTooOld) or can't be run at all (not found): the app is blocked. */
export const useGitCheck = create<GitCheck>((set, get) => ({
  problem: null,
  async check() {
    try {
      await api.appInfo();
      set({ problem: null });
    } catch (e) {
      if (isGbError(e) && (e.kind === 'GitTooOld' || gitNotFound(e))) set({ problem: e });
      else console.warn('[gitbolt] git check failed; continuing', e);
    }
  },
  /** Re-checks; once git is fine, reloads so boot opens the repos it skipped. */
  async retry() {
    await get().check();
    if (get().problem === null) location.reload();
  },
}));
