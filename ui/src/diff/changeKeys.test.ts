import { afterEach, describe, expect, it } from 'vitest';
import { changeKeyDirection } from './changeKeys';

afterEach(() => { document.body.innerHTML = ''; });

/** jsdom has no `isContentEditable`: give `el` the browser's answer. */
const editable = (el: HTMLElement, on: boolean) => Object.defineProperty(el, 'isContentEditable', { configurable: true, value: on });
const shiftDown = (target: Element) => {
  const e = new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true });
  Object.defineProperty(e, 'target', { value: target });
  return changeKeyDirection(e);
};

describe('changeKeyDirection: Shift+↑/↓ stay a text selection in editable text', () => {
  it('any editable element, whatever its contenteditable spelling (isContentEditable)', () => {
    document.body.innerHTML = '<div id="empty" contenteditable=""></div><div id="plain" contenteditable="plaintext-only"></div><div id="host" contenteditable="true"><span id="inner">x</span></div>';
    for (const id of ['empty', 'plain', 'inner']) {
      const el = document.getElementById(id)!;
      editable(el, true);
      expect(shiftDown(el), id).toBeNull();
    }
  });

  it('a contenteditable="false" island, or a plain element, still steps the changes', () => {
    document.body.innerHTML = '<div contenteditable="true"><span id="island" contenteditable="false">x</span></div><div id="plain">y</div>';
    const island = document.getElementById('island')!;
    editable(island, false);
    expect(shiftDown(island)).toBe('next');
    const plain = document.getElementById('plain')!;
    editable(plain, false);
    expect(shiftDown(plain)).toBe('next');
  });

  it('inputs, Monaco and menus keep them too', () => {
    document.body.innerHTML = '<input id="i"><div class="monaco-editor"><textarea id="m"></textarea></div><div role="menu"><div id="r" role="menuitem"></div></div>';
    for (const id of ['i', 'm', 'r']) expect(shiftDown(document.getElementById(id)!), id).toBeNull();
  });
});
