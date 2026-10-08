import { Info } from 'lucide-react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ev = vi.hoisted(() => ({ handler: null as null | ((e: { payload: string }) => void), unlisten: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, h: (e: { payload: string }) => void) => {
    if (name === 'gb:menu') ev.handler = h;
    return ev.unlisten;
  }),
}));

const { registerActions } = await import('./actions');
const { installNativeMenu, MENU_EVENT } = await import('./nativeMenu');

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  ev.handler = null;
});

describe('the native menu bar (macOS, crates/gitbolt-app/src/menu.rs)', () => {
  it("runs the app action an item names, as its shortcut would, and stops listening when removed", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    const run = vi.fn();
    const offAction = registerActions([{ id: 't.menuItem', label: 'Item', group: 'Help', icon: Info, tooltip: 'Item', run }]);
    const off = installNativeMenu();
    await vi.waitFor(() => expect(ev.handler).not.toBeNull());
    expect(MENU_EVENT).toBe('gb:menu');
    ev.handler!({ payload: 't.menuItem' });
    expect(run).toHaveBeenCalledTimes(1);
    ev.handler!({ payload: 'no.such.action' });
    expect(run).toHaveBeenCalledTimes(1);
    off();
    expect(ev.unlisten).toHaveBeenCalled();
    offAction();
  });

  it('listens only in the app (Tauri), not in the browser harness', async () => {
    const off = installNativeMenu();
    await Promise.resolve();
    expect(ev.handler).toBeNull();
    off();
  });
});
