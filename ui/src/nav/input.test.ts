import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hist = vi.hoisted(() => ({ navBack: vi.fn(async () => {}), navForward: vi.fn(async () => {}) }));
vi.mock('./history', async (actual) => ({ ...(await actual<typeof import('./history')>()), ...hist }));

await import('./feature');
const { activeTabWith } = await import('../app/testShell');
const { getAction } = await import('../app/actions');
const { actionEntries } = await import('../palette/sources');
const { shortcutSections } = await import('../shortcuts/catalog');

beforeEach(() => {
  vi.clearAllMocks();
  activeTabWith();
});
afterEach(() => { document.body.innerHTML = ''; });

/** jsdom lays nothing out: an element "shown" reports one client rect. */
const shown = <T extends HTMLElement>(el: T): T => {
  el.getClientRects = () => ({ length: 1 }) as unknown as DOMRectList;
  return el;
};
const add = (html: string): HTMLElement => {
  const box = document.createElement('div');
  box.innerHTML = html;
  document.body.append(box);
  return box.firstElementChild as HTMLElement;
};
/** Dispatches a mouse event; true unless something prevented its default. */
const press = (type: 'mousedown' | 'mouseup' | 'auxclick', button: number, target: Element = document.body) =>
  target.dispatchEvent(new MouseEvent(type, { button, bubbles: true, cancelable: true }));
const altKey = (key: string, init: KeyboardEventInit = {}, target: Element = document.body) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key, altKey: true, bubbles: true, cancelable: true, ...init }));

describe('mouse back / forward (spec #5 §3.4)', () => {
  it('button 3 goes back and button 4 forward, in the active tab', () => {
    press('mouseup', 3);
    expect(hist.navBack).toHaveBeenCalledWith('t');
    press('mouseup', 4);
    expect(hist.navForward).toHaveBeenCalledWith('t');
  });

  it("the side buttons' own press and auxclick are prevented, so the webview never navigates", () => {
    for (const type of ['mousedown', 'auxclick', 'mouseup'] as const) {
      expect(press(type, 3)).toBe(false);
      expect(press(type, 4)).toBe(false);
    }
    expect(press('mousedown', 0)).toBe(true);
    // Even where Back is suppressed (a text field), the webview mustn't go back.
    expect(press('mouseup', 3, add('<input type="text" />'))).toBe(false);
  });

  it('does nothing in a text field, a Monaco editor, an open menu or a modal dialog, but works over the MR/PR flyout', () => {
    press('mouseup', 3, add('<input type="text" />'));
    press('mouseup', 3, add('<div class="monaco-editor"><div class="view-lines"></div></div>').firstElementChild!);
    expect(hist.navBack).not.toHaveBeenCalled();
    const menu = shown(add('<div role="menu"></div>'));
    press('mouseup', 3);
    expect(hist.navBack).not.toHaveBeenCalled();
    menu.remove();
    const modal = shown(add('<div role="dialog" aria-modal="true"></div>'));
    press('mouseup', 3);
    expect(hist.navBack).not.toHaveBeenCalled();
    modal.remove();
    // The palette is a dialog too (not modal, but not the flyout).
    const palette = shown(add('<div class="palette" role="dialog" aria-label="Command palette"></div>'));
    press('mouseup', 3);
    expect(hist.navBack).not.toHaveBeenCalled();
    palette.remove();
    const flyout = shown(add('<section role="dialog" aria-modal="false" data-flyout=""><p>!12</p></section>'));
    press('mouseup', 3, flyout.firstElementChild!);
    expect(hist.navBack).toHaveBeenCalledWith('t');
  });
});

describe('Alt+← / Alt+→', () => {
  it('go back and forward, taking the key', () => {
    expect(altKey('ArrowLeft')).toBe(false);
    expect(hist.navBack).toHaveBeenCalledWith('t');
    altKey('ArrowRight');
    expect(hist.navForward).toHaveBeenCalledWith('t');
  });

  it('leave other chords alone, and the key to a text field or Monaco', () => {
    expect(altKey('ArrowLeft', { shiftKey: true })).toBe(true);
    expect(altKey('ArrowLeft', { ctrlKey: true })).toBe(true);
    expect(altKey('ArrowLeft', { altKey: false })).toBe(true);
    expect(altKey('ArrowLeft', {}, add('<textarea></textarea>'))).toBe(true);
    expect(altKey('ArrowLeft', {}, add('<div class="monaco-editor"><textarea class="inputarea"></textarea></div>').firstElementChild!)).toBe(true);
    expect(hist.navBack).not.toHaveBeenCalled();
  });
});

describe('the actions (palette, shortcuts panel)', () => {
  it('Go back and Go forward are in the palette and the Navigation section, with their keys', () => {
    const ours = (label: string) => label === 'Go back' || label === 'Go forward';
    expect(actionEntries().filter((e) => ours(e.label)).map((e) => [e.label, e.detail])).toEqual([['Go back', 'Alt+Left'], ['Go forward', 'Alt+Right']]);
    const nav = shortcutSections().find((s) => s.title === 'Navigation')!;
    expect(nav.rows.filter((r) => ours(r.label)).map((r) => [r.label, r.keys])).toEqual([['Go back', ['Alt+Left', 'Mouse back']], ['Go forward', ['Alt+Right', 'Mouse forward']]]);
    void getAction('nav.back')!.run();
    expect(hist.navBack).toHaveBeenCalledWith('t');
  });
});
