// @vitest-environment happy-dom
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const run = vi.hoisted(() => ({ gotoClipboard: vi.fn(async () => {}) }));
vi.mock('./run', () => run);

const { useAppState } = await import('../app/state');
const { getAction } = await import('../app/actions');
const { installShortcuts } = await import('../app/shortcuts');
const { allActions } = await import('../app/actions');
await import('./feature');
const { shortcutSections } = await import('../shortcuts/catalog');

const ctrlV = () => new KeyboardEvent('keydown', { key: 'v', code: 'KeyV', ctrlKey: true, bubbles: true, cancelable: true });
let off: () => void;
beforeAll(() => {
  useAppState.setState({ profile: { ...useAppState.getState().profile, tabs: [{ id: 't1', kind: 'repo', path: '/home/ada/harbor', alias: null }], activeTab: 't1' } });
  off = installShortcuts();
});
afterAll(() => off());
beforeEach(() => run.gotoClipboard.mockClear());

/** Dispatches Ctrl+V at `el` (in the document while it does). */
function press(el: HTMLElement): KeyboardEvent {
  document.body.append(el);
  const e = ctrlV();
  el.dispatchEvent(e);
  el.remove();
  return e;
}

describe("Go to what's on the clipboard (Ctrl+V)", () => {
  it('is an action with Ctrl+V, listed in the Keyboard Shortcuts panel and the palette', () => {
    expect(getAction('edit.gotoClipboard')).toMatchObject({ label: "Go to what's on the clipboard", shortcuts: ['Ctrl+V'] });
    expect(allActions().some((a) => a.id === 'edit.gotoClipboard')).toBe(true);
    expect(shortcutSections().flatMap((s) => s.rows).find((r) => r.id === 'edit.gotoClipboard')?.keys).toEqual(['Ctrl+V']);
  });

  it('runs outside a text field, taking the key from the browser', () => {
    const div = document.createElement('div');
    div.tabIndex = 0;
    const e = press(div);
    expect(run.gotoClipboard).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
  });

  it('runs once for a held key: its repeats are swallowed', () => {
    const div = document.createElement('div');
    document.body.append(div);
    const held = new KeyboardEvent('keydown', { key: 'v', code: 'KeyV', ctrlKey: true, repeat: true, bubbles: true, cancelable: true });
    div.dispatchEvent(held);
    div.remove();
    expect(held.defaultPrevented).toBe(true);
    expect(run.gotoClipboard).not.toHaveBeenCalled();
  });

  it('leaves the key to text fields and to every Monaco editor, a read-only one too', () => {
    const input = document.createElement('input');
    const area = document.createElement('textarea');
    const monaco = document.createElement('div');
    monaco.className = 'monaco-editor';
    const inner = document.createElement('textarea');
    monaco.append(inner);
    // (contenteditable too, `isEditableTarget`: jsdom has no `isContentEditable`)
    for (const el of [input, area]) expect(press(el).defaultPrevented).toBe(false);
    document.body.append(monaco);
    const e = ctrlV();
    inner.dispatchEvent(e);
    monaco.remove();
    expect(e.defaultPrevented).toBe(false);
    expect(run.gotoClipboard).not.toHaveBeenCalled();
  });

  it('does nothing while a menu owns the keys', () => {
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    document.body.append(menu);
    menu.getClientRects = () => [{}] as unknown as DOMRectList;
    press(document.createElement('div'));
    menu.remove();
    expect(run.gotoClipboard).not.toHaveBeenCalled();
  });

  it('is unavailable with no repository tab open', () => {
    const was = useAppState.getState().profile;
    useAppState.setState({ profile: { ...was, tabs: [{ id: 'o', kind: 'open', path: null, alias: null }], activeTab: 'o' } });
    press(document.createElement('div'));
    useAppState.setState({ profile: was });
    expect(run.gotoClipboard).not.toHaveBeenCalled();
  });
});
