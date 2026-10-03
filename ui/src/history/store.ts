import { createStore, type StoreApi } from 'zustand/vanilla';
import { errorMessage } from '../api/client';
import type { FileHistoryPage } from '../api/gen/FileHistoryPage';
import { initialHistory, stepSelection, withPage, type FileHistoryArgs, type HistoryState } from './model';

/** The page size (spec #3 §3.10). */
export const HISTORY_PAGE = 200;
/** How many more pages a blame click looks through for its commit. */
export const SEEK_PAGES = 10;

export interface HistoryStore extends HistoryState {
  /** The next page; the one in flight if there is one. */
  loadMore(): Promise<void>;
  select(sha: string): void;
  step(dir: 1 | -1): void;
  /** Selects `sha`, loading pages until it shows (at most `SEEK_PAGES`); false if it never did. */
  seek(sha: string): Promise<boolean>;
  setBlame(on: boolean): void;
}

/** One open File History's state. `fetchPage(skip)`: the page after `skip` rows. */
export function createHistoryStore(args: FileHistoryArgs, fetchPage: (skip: number) => Promise<FileHistoryPage>): StoreApi<HistoryStore> {
  let inflight: Promise<void> | null = null;
  return createStore<HistoryStore>((set, get) => ({
    ...initialHistory(args),
    loadMore() {
      if (inflight) return inflight;
      if (!get().more) return Promise.resolve();
      set({ loading: true, error: null });
      inflight = fetchPage(get().rows.length)
        .then((page) => set((s) => withPage(s, page)), (e: unknown) => set({ loading: false, error: errorMessage(e) }))
        .finally(() => { inflight = null; });
      return inflight;
    },
    select(sha) {
      if (get().rows.some((r) => r.sha === sha)) set({ selected: sha });
    },
    step(dir) {
      set((s) => stepSelection(s, dir));
    },
    async seek(sha) {
      for (let pages = 0; ; pages++) {
        if (get().rows.some((r) => r.sha === sha)) {
          set({ selected: sha });
          return true;
        }
        if (!get().more || get().error || pages >= SEEK_PAGES) return false;
        await get().loadMore();
      }
    },
    setBlame(on) {
      set({ blame: on });
    },
  }));
}
