import { describe, expect, it, vi } from 'vitest';
import { installStaleBuildReload } from './staleBuild';

function fakeWindow() {
  const handlers: ((e: Event) => void)[] = [];
  const store = new Map<string, string>();
  const reload = vi.fn();
  const win = {
    addEventListener: (_: string, h: (e: Event) => void) => handlers.push(h),
    sessionStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) },
    location: { reload },
  } as unknown as Window;
  const fire = () => {
    const e = new Event('vite:preloadError', { cancelable: true });
    handlers.forEach((h) => h(e));
    return e.defaultPrevented;
  };
  return { win, fire, reload };
}

describe('a chunk gone after a deploy', () => {
  it('reloads once, then not again within 30 seconds, then again after', () => {
    let t = 1_000_000;
    const { win, fire, reload } = fakeWindow();
    installStaleBuildReload(win, () => t);
    expect(fire()).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    t += 10_000;
    expect(fire()).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
    t += 30_000;
    fire();
    expect(reload).toHaveBeenCalledTimes(2);
  });
});
