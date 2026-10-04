import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import type { ForgeProjectSettings } from '../../api/gen/ForgeProjectSettings';
import { useRuntime } from '../../app/runtime';

const cache = new Map<string, Promise<ForgeProjectSettings | null>>();

/** The target project's merge settings (4A's `forgeProjectSettings`), asked once per repository
 * and remote for the session; a failure is asked again next time. */
export function useProjectSettings(tabId: string, remote: string | null): ForgeProjectSettings | null {
  const repo = useRuntime((s) => s.tabs[tabId]?.repo?.id);
  const [settings, setSettings] = useState<ForgeProjectSettings | null>(null);
  useEffect(() => {
    if (repo === undefined || !remote) return;
    let live = true;
    const key = `${repo}:${remote}`;
    let p = cache.get(key);
    if (!p) {
      p = api.forgeProjectSettings(repo, remote).catch(() => null);
      cache.set(key, p);
    }
    void p.then((s) => {
      if (!s) cache.delete(key);
      if (live) setSettings(s);
    });
    return () => {
      live = false;
    };
  }, [repo, remote]);
  return settings;
}

/** Tests only. */
export const resetProjectSettings = (): void => cache.clear();
