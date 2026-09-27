import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MonacoHost } from './host';

// A fake Monaco that models what matters here: an editor created with an undefined theme falls
// back to `vs` (light), as Monaco 0.57's theme service does, and a later defineTheme doesn't
// re-apply it. The real @shikijs/monaco runs against it with a fake highlighter. Mocked modules
// survive vi.resetModules, so `reset()` restores a pristine fake (shikiToMonaco wraps
// `editor.create` and `editor.setTheme` in place).
vi.mock('./setup', () => {
  type Listener = (e: unknown) => void;
  const state = {
    defined: new Set(['vs', 'vs-dark', 'hc-black']),
    applied: 'vs',
    themeAtCreate: [] as string[],
    diffAutoUpdate: true,
    diffs: [] as ReturnType<typeof diffEditor>[],
    files: [] as ReturnType<typeof codeEditor>[],
  };
  const apply = (theme?: string) => {
    if (theme) state.applied = state.defined.has(theme) ? theme : 'vs';
  };
  function codeEditor() {
    const menus: Listener[] = [];
    return {
      menus,
      onContextMenu: (cb: Listener) => {
        menus.push(cb);
        return { dispose() {} };
      },
      getSelection: () => null,
      focus: vi.fn(),
      updateOptions: vi.fn(),
      setModel: vi.fn(),
      layout: vi.fn(),
    };
  }
  function diffEditor() {
    const listeners = new Set<() => void>();
    const original = codeEditor();
    const modified = codeEditor();
    return {
      listeners,
      original,
      modified,
      getOriginalEditor: () => original,
      getModifiedEditor: () => modified,
      onDidUpdateDiff: (cb: () => void) => {
        listeners.add(cb);
        return { dispose: () => listeners.delete(cb) };
      },
      setModel: vi.fn(() => {
        if (state.diffAutoUpdate) queueMicrotask(() => [...listeners].forEach((l) => l()));
      }),
      updateOptions: vi.fn(),
      layout: vi.fn(),
      goToDiff: vi.fn(),
    };
  }
  const editor = () => ({
    defineTheme: (name: string) => void state.defined.add(name),
    setTheme: (name: string) => apply(name),
    create: (_el: HTMLElement, opts?: { theme?: string }) => {
      apply(opts?.theme);
      state.themeAtCreate.push(state.applied);
      const ed = codeEditor();
      state.files.push(ed);
      return ed;
    },
    createDiffEditor: (_el: HTMLElement, opts?: { theme?: string }) => {
      apply(opts?.theme);
      state.themeAtCreate.push(state.applied);
      const ed = diffEditor();
      state.diffs.push(ed);
      return ed;
    },
    createModel: (text: string, language: string) => ({ text, language, dispose: vi.fn() }),
  });
  const monaco = {
    editor: editor(),
    languages: { getLanguages: () => [{ id: 'plaintext' }], register: vi.fn(), setTokensProvider: vi.fn() },
  };
  const reset = () => {
    Object.assign(state, { defined: new Set(['vs', 'vs-dark', 'hc-black']), applied: 'vs', themeAtCreate: [], diffAutoUpdate: true, diffs: [], files: [] });
    monaco.editor = editor();
  };
  return { monaco, state, reset };
});

// A grammar load the test can hold open (`gate.wait`), to reorder prefs changes around it.
const gate = vi.hoisted(() => ({ wait: null as Promise<void> | null }));
vi.mock('shiki/core', () => ({
  createHighlighterCore: vi.fn(async () => ({
    getLoadedThemes: () => ['dark-plus'],
    getTheme: () => ({ type: 'dark', colors: { 'editor.background': '#1e1e1e' }, settings: [] }),
    setTheme: () => ({ colorMap: [] }),
    getLoadedLanguages: () => [],
    loadLanguage: async () => {
      if (gate.wait) await gate.wait;
    },
  })),
}));
vi.mock('shiki/engine/oniguruma', () => ({ createOnigurumaEngine: () => ({}) }));
vi.mock('shiki/wasm', () => ({ default: {} }));

interface FakeCodeEditor { menus: ((e: unknown) => void)[]; focus: ReturnType<typeof vi.fn>; updateOptions: ReturnType<typeof vi.fn>; setModel: ReturnType<typeof vi.fn> }
interface FakeState {
  defined: Set<string>;
  applied: string;
  themeAtCreate: string[];
  diffAutoUpdate: boolean;
  diffs: { listeners: Set<() => void>; original: FakeCodeEditor; modified: FakeCodeEditor; updateOptions: ReturnType<typeof vi.fn> }[];
  files: FakeCodeEditor[];
}

async function fresh(): Promise<{ host: MonacoHost; state: FakeState }> {
  vi.resetModules();
  const { state, reset } = (await import('./setup')) as unknown as { state: FakeState; reset(): void };
  reset();
  const { loadMonacoHost } = await import('./load');
  return { host: await loadMonacoHost(), state };
}

const prefs = { mode: 'inline', ignoreWhitespace: false, wordWrap: false } as const;
const diffReq = (path: string, language = 'plaintext') => ({ path, original: 'a\n', modified: 'b\n', language, prefs });
const menuEvent = () => ({ target: { position: { lineNumber: 7 } }, event: { posx: 10, posy: 20, preventDefault: vi.fn() } });

beforeEach(() => {
  vi.useRealTimers();
  gate.wait = null;
});
afterEach(() => vi.useRealTimers());

describe('MonacoHost', () => {
  it('shows a plain-text file in the Shiki dark theme, defined before the editor exists', async () => {
    const { host, state } = await fresh();
    host.attachFile(document.createElement('div'));
    await host.showFile({ path: 'LICENSE', text: 'MIT\n', language: 'plaintext', wordWrap: false });
    expect(state.defined.has('dark-plus')).toBe(true);
    expect(state.themeAtCreate).toEqual(['dark-plus']);
    expect(state.applied).toBe('dark-plus');
  });

  it('creates the diff editor in the Shiki dark theme too, for plain text and highlighted files', async () => {
    const { host, state } = await fresh();
    host.attachDiff(document.createElement('div'));
    await host.showDiff(diffReq('notes.txt'));
    await host.showDiff(diffReq('a.php', 'php'));
    expect(state.themeAtCreate).toEqual(['dark-plus']);
    expect(state.applied).toBe('dark-plus');
  });

  it('routes right-clicks to the 1C handler with its own path per editor, and blocks the native menu', async () => {
    const { host, state } = await fresh();
    host.attachDiff(document.createElement('div'));
    host.attachFile(document.createElement('div'));
    await host.showDiff(diffReq('diffed.txt'));
    await host.showFile({ path: 'viewed.txt', text: 'x\n', language: 'plaintext', wordWrap: false });

    const unhandled = menuEvent();
    state.diffs[0].modified.menus[0](unhandled);
    expect(unhandled.event.preventDefault).not.toHaveBeenCalled();

    const handler = vi.fn();
    host.setContextMenuHandler(handler);
    const onDiff = menuEvent();
    state.diffs[0].modified.menus[0](onDiff);
    const onFile = menuEvent();
    state.files[0].menus[0](onFile);
    expect(handler.mock.calls.map(([e]) => [e.path, e.side, e.line, e.x, e.y])).toEqual([
      ['diffed.txt', 'modified', 7, 10, 20],
      ['viewed.txt', 'file', 7, 10, 20],
    ]);
    expect(onDiff.event.preventDefault).toHaveBeenCalled();
    expect(onFile.event.preventDefault).toHaveBeenCalled();
  });

  it('leaves no timer or diff listener behind, whether the diff computes or the backstop fires', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { host, state } = await fresh();
    host.attachDiff(document.createElement('div'));
    await host.showDiff(diffReq('a.txt'));
    expect(vi.getTimerCount()).toBe(0);
    // Only the host's own permanent listener (the `data-diff-computed` counter) remains.
    expect(state.diffs[0].listeners.size).toBe(1);

    state.diffAutoUpdate = false;
    const shown = host.showDiff(diffReq('b.txt'));
    await vi.advanceTimersByTimeAsync(5000);
    await shown;
    expect(vi.getTimerCount()).toBe(0);
    // Only the host's own permanent listener (the `data-diff-computed` counter) remains.
    expect(state.diffs[0].listeners.size).toBe(1);
  });

  it("focus() focuses the attached editor: the diff's modified side, else the file editor", async () => {
    const { host, state } = await fresh();
    host.focus(); // nothing attached yet: a no-op
    const diffBox = document.createElement('div');
    host.attachDiff(diffBox);
    host.focus();
    expect(state.diffs[0].modified.focus).toHaveBeenCalledTimes(1);
    expect(state.diffs[0].original.focus).not.toHaveBeenCalled();
    host.detachDiff(diffBox);
    host.attachFile(document.createElement('div'));
    host.focus();
    expect(state.files[0].focus).toHaveBeenCalledTimes(1);
    expect(state.diffs[0].modified.focus).toHaveBeenCalledTimes(1);
  });

  it('setFileWordWrap updates the file editor in place, keeping its model (and scroll position)', async () => {
    const { host, state } = await fresh();
    host.attachFile(document.createElement('div'));
    await host.showFile({ path: 'a.txt', text: 'x\n', language: 'plaintext', wordWrap: false });
    const ed = state.files[0];
    host.setFileWordWrap(true);
    expect(ed.updateOptions).toHaveBeenLastCalledWith(expect.objectContaining({ wordWrap: 'on' }));
    host.setFileWordWrap(false);
    expect(ed.updateOptions).toHaveBeenLastCalledWith(expect.objectContaining({ wordWrap: 'off' }));
    expect(ed.setModel).toHaveBeenCalledTimes(1);
  });

  it('a wrap toggle during a pending grammar load wins over the value showFile was called with', async () => {
    const { host, state } = await fresh();
    host.attachFile(document.createElement('div'));
    let release!: () => void;
    gate.wait = new Promise<void>((r) => { release = r; });
    const shown = host.showFile({ path: 'a.php', text: '<?php\n', language: 'php', wordWrap: false });
    host.setFileWordWrap(true);
    release();
    await shown;
    expect(state.files[0].setModel).toHaveBeenCalledTimes(1);
    expect(state.files[0].updateOptions).toHaveBeenLastCalledWith(expect.objectContaining({ wordWrap: 'on' }));
  });

  it('a prefs change during a pending grammar load wins over the prefs showDiff was called with', async () => {
    const { host, state } = await fresh();
    const box = document.createElement('div');
    host.attachDiff(box);
    let release!: () => void;
    gate.wait = new Promise<void>((r) => { release = r; });
    const shown = host.showDiff(diffReq('a.php', 'php'));
    host.setDiffPrefs({ mode: 'split', ignoreWhitespace: true, wordWrap: false });
    release();
    await shown;
    expect(state.diffs[0].updateOptions).toHaveBeenLastCalledWith(expect.objectContaining({ renderSideBySide: true, ignoreTrimWhitespace: true }));
  });

  it('counts computed diffs on the host element (data-diff-computed), for e2e waits', async () => {
    const { host } = await fresh();
    const box = document.createElement('div');
    host.attachDiff(box);
    await host.showDiff(diffReq('a.txt'));
    await host.showDiff(diffReq('b.txt'));
    expect(box.querySelector<HTMLElement>('.monaco-host')?.dataset.diffComputed).toBe('2');
  });
});
