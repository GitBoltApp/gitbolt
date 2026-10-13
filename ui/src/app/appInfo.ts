import { create } from 'zustand';
import { api } from '../api/client';
import type { AppInfoPayload } from '../api/gen/AppInfoPayload';
import { tildePath } from './osPath';

/** The About dialog's version info (Task 9's `api.appInfo`), loaded once on first use. */
export const useAppInfo = create<{ info: AppInfoPayload | null; load(): Promise<void> }>((set, get) => ({
  info: null,
  async load() {
    if (!get().info) set({ info: await api.appInfo() });
  },
}));

/** A function writing a path with the home folder as `~`, for display (titles keep the full path). */
export function useTilde(): (path: string) => string {
  const home = useAppInfo((s) => s.info?.home);
  return (path) => tildePath(path, home);
}
