import { afterEach, describe, expect, it, vi } from 'vitest';
import { KEY_LAYERS, registerKeys, type KeyHandler, type KeyLayer } from './keyRouter';

const offs: (() => void)[] = [];
afterEach(() => {
  offs.splice(0).forEach((off) => off());
  document.body.innerHTML = '';
});

const reg = (layer: KeyLayer, h: KeyHandler) => offs.push(registerKeys(layer, h));
const press = (target: EventTarget, key: string) => {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  target.dispatchEvent(e);
  return e;
};
const pressCtrl = (target: EventTarget, key: string) => {
  const e = new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true });
  target.dispatchEvent(e);
  return e;
};

describe('keyRouter: one dispatcher, fixed layer precedence', () => {
  it('the higher layer wins whatever the registration order (menu > tooltip > overlay > app)', () => {
    for (const order of [KEY_LAYERS, [...KEY_LAYERS].reverse()]) {
      const seen: string[] = [];
      for (const layer of order) reg(layer, () => void seen.push(layer));
      const claimOnly = (layer: KeyLayer) => reg(layer, (e) => (e.key === layer ? 'handled' : undefined));
      for (const layer of order) claimOnly(layer);
      for (const layer of KEY_LAYERS) {
        seen.length = 0;
        press(document.body, layer);
        // Every layer down to the claiming one is asked; none below it.
        expect(seen).toEqual(KEY_LAYERS.slice(0, KEY_LAYERS.indexOf(layer) + 1));
      }
      offs.splice(0).forEach((off) => off());
    }
  });

  it("'handled' stops the key at the window; 'native' lets it reach its target but no lower layer", () => {
    const app = vi.fn();
    const page = vi.fn();
    document.body.innerHTML = '<button>b</button>';
    const button = document.querySelector('button')!;
    button.addEventListener('keydown', page);
    reg('app', app);
    const off = registerKeys('overlay', () => 'native');
    press(button, 'Escape');
    expect(page).toHaveBeenCalledTimes(1);
    expect(app).not.toHaveBeenCalled();
    off();
    reg('tooltip', () => 'handled');
    press(button, 'Escape');
    expect(page).toHaveBeenCalledTimes(1);
    expect(app).not.toHaveBeenCalled();
  });

  it('every handler in the claiming layer is offered the key (two tooltips both close)', () => {
    const a = vi.fn(() => 'handled' as const);
    const b = vi.fn(() => 'handled' as const);
    reg('tooltip', a);
    reg('tooltip', b);
    press(document.body, 'Escape');
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('a shown [role="menu"] keeps every key from the lower layers, for its own handler', () => {
    const app = vi.fn();
    reg('app', app);
    document.body.innerHTML = '<div role="menu" tabindex="-1"><button role="menuitem">x</button></div><button id="out">o</button>';
    const item = document.querySelector('[role="menuitem"]')!;
    const own = vi.fn();
    item.addEventListener('keydown', own);
    // jsdom has no layout: a key pressed inside the menu is enough.
    for (const key of ['F7', 'Escape', 'ArrowDown']) press(item, key);
    expect(own).toHaveBeenCalledTimes(3);
    expect(app).not.toHaveBeenCalled();
    // Shown (it has a box) while the focus is outside it.
    const menu = document.querySelector('[role="menu"]')!;
    vi.spyOn(menu, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
    press(document.getElementById('out')!, 'F7');
    expect(app).not.toHaveBeenCalled();
    menu.remove();
    press(document.getElementById('out')!, 'F7');
    expect(app).toHaveBeenCalledTimes(1);
  });

  it('the zoom keys (Ctrl+=/-/0, H2) reach the app layer even while a menu is shown, or a menu-layer handler claims every other key (ContextMenu\'s own catch-all)', () => {
    const app = vi.fn(() => 'handled' as const);
    reg('app', app);
    // A menu-layer handler that, like ContextMenu.tsx, claims every key while open.
    reg('menu', () => 'handled');
    document.body.innerHTML = '<div role="menu" tabindex="-1"><button role="menuitem">x</button></div>';
    const menu = document.querySelector('[role="menu"]')!;
    vi.spyOn(menu, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
    for (const k of ['=', '-', '0']) pressCtrl(document.body, k);
    expect(app).toHaveBeenCalledTimes(3);
    // A non-zoom key is still swallowed by the menu layer, as before.
    press(document.body, 'F7');
    expect(app).toHaveBeenCalledTimes(3);
  });

  it('the window listener is there only while a handler is registered', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const off1 = registerKeys('app', () => undefined);
    const off2 = registerKeys('menu', () => undefined);
    expect(add.mock.calls.filter(([t]) => t === 'keydown')).toHaveLength(1);
    off1();
    expect(remove.mock.calls.filter(([t]) => t === 'keydown')).toHaveLength(0);
    off2();
    expect(remove.mock.calls.filter(([t]) => t === 'keydown')).toHaveLength(1);
    add.mockRestore();
    remove.mockRestore();
  });
});
