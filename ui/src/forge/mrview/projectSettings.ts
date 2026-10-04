import { useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../../api/client';
import type { ForgeProjectSettings } from '../../api/gen/ForgeProjectSettings';
import { useRuntime } from '../../app/runtime';
import { useTabForgeField } from '../mrStore';

const cache = new Map<string, Promise<ForgeProjectSettings>>();

export interface ProjectSettingsState {
  settings: ForgeProjectSettings | null;
  /** Why they couldn't be loaded; they're asked again on the tab's next poll, or a remount. */
  error: string | null;
}

/** The target project's merge settings (4A's `forgeProjectSettings`), asked once per repository
 * and remote for the session; a failure is kept, and asked again after the next poll. */
export function useProjectSettings(tabId: string, remote: string | null): ProjectSettingsState {
  const repo = useRuntime((s) => s.tabs[tabId]?.repo?.id);
  const polledAt = useTabForgeField(tabId, 'updatedAt');
  const [state, setState] = useState<ProjectSettingsState>({ settings: null, error: null });
  const [attempt, setAttempt] = useState(0);
  const failed = useRef(false);
  useEffect(() => {
    if (failed.current) setAttempt((n) => n + 1);
  }, [polledAt]);
  useEffect(() => {
    if (repo === undefined || !remote) return;
    let live = true;
    const key = `${repo}:${remote}`;
    const p = cache.get(key) ?? api.forgeProjectSettings(repo, remote);
    cache.set(key, p);
    p.then(
      (settings) => {
        failed.current = false;
        if (live) setState({ settings, error: null });
      },
      (e: unknown) => {
        if (cache.get(key) === p) cache.delete(key);
        failed.current = true;
        if (live) setState((cur) => ({ settings: cur.settings, error: errorMessage(e) }));
      },
    );
    return () => {
      live = false;
    };
  }, [repo, remote, attempt]);
  return state;
}

/** Tests only. */
export const resetProjectSettings = (): void => cache.clear();
