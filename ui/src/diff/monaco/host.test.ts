import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
    lineChanges: null as unknown,
    diffs: [] as ReturnType<typeof diffEditor>[],
    files: [] as ReturnType<typeof codeEditor>[],
  };
  const apply = (theme?: string) => {
    if (theme) state.applied = state.defined.has(theme) ? theme : 'vs';
  };
  // Layout, as Monaco's view layout does it: model lines map to view lines (a hidden line, in
  // Hunk's collapsed regions, maps onto the last visible line above it, as Monaco's
  // convertModelPositionToViewPosition does by default), 19 px per visible line unless `heights`
  // says otherwise (wrapped lines), plus view zones ({ after: model line, height }) placed after
  // the view line their model line maps to. `top(n, true)` is the top of the zones above line n,
  // `top(n)` line n's own top, `bottom(n)` the bottom of its (last wrapped) visual line.
  function codeEditor() {
    const menus: Listener[] = [];
    const mouseUps: Listener[] = [];
    const inputs: Listener[] = [];
    // A real element so `getBoundingClientRect` (the keyboard menu's position, fix round 1) is a
    // normal DOM stub, not another fake to maintain.
    const domNode = document.createElement('div');
    vi.spyOn(domNode, 'getBoundingClientRect').mockReturnValue({ left: 100, top: 200, right: 0, bottom: 0, width: 0, height: 0, x: 100, y: 200, toJSON: () => ({}) });
    const ed = {
      menus,
      mouseUps,
      inputs,
      model: null as unknown as { getLineCount(): number } | null,
      zones: [] as { after: number; height: number }[],
      // Hunk's collapsed lines ([first, last]).
      hidden: [] as [number, number][],
      // Per-line heights other than 19 px (wrapped lines).
      heights: {} as Record<number, number>,
      sizeListeners: [] as Listener[],
      scrollListeners: [] as Listener[],
      scrollTop: 0,
      // Inside a view-model change (Monaco's beginEmitViewEvents … endEmitViewEvents): a scroll
      // event waits for the end, as Monaco's outgoing events do.
      collecting: false,
      pendingScroll: false,
      scrolled: () => {
        if (ed.collecting) ed.pendingScroll = true;
        else ed.scrollListeners.forEach((l) => l({ scrollTopChanged: true }));
      },
      getModel() { return ed.model; },
      count: () => ed.model?.getLineCount() ?? 1,
      isHidden: (n: number) => ed.hidden.some(([a, b]) => a <= n && n <= b),
      /** The visible model line that line `n` shows as (itself, or the last visible one above). */
      shownAs: (n: number) => {
        let v = Math.max(1, Math.min(n, ed.count()));
        while (v > 1 && ed.isHidden(v)) v--;
        return v;
      },
      /** Zones whose view position (the visible line they come after; 0 = above line 1) is `test`ed. */
      zonesAt: (test: (pos: number) => boolean) => ed.zones.filter((z) => test(z.after === 0 ? 0 : ed.shownAs(z.after))).reduce((acc, z) => acc + z.height, 0),
      getTopForLineNumber: (n: number, includeViewZones = false) => {
        const v = ed.shownAs(n);
        const above = v === 1 ? 0 : ed.shownAs(v - 1); // the visible line right above v (0: none)
        let top = 0;
        for (let i = 1; i < v; i++) if (!ed.isHidden(i)) top += ed.heights[i] ?? 19;
        return top + ed.zonesAt((pos) => pos < above) + (includeViewZones ? 0 : ed.zonesAt((pos) => pos === above));
      },
      getBottomForLineNumber: (n: number) => {
        const v = ed.shownAs(n);
        return ed.getTopForLineNumber(v) + (ed.heights[v] ?? 19);
      },
      getContentHeight: () => ed.getBottomForLineNumber(ed.count()) + ed.zonesAt((pos) => pos === ed.shownAs(ed.count())),
      getScrollTop: () => ed.scrollTop,
      getScrollHeight: () => ed.getContentHeight() + 500 - 19,
      // The visible lines in the viewport (500 px), as ranges.
      getVisibleRanges: () => {
        const out: { startLineNumber: number; endLineNumber: number }[] = [];
        for (let i = 1; i <= ed.count(); i++) {
          if (ed.isHidden(i)) continue;
          if (ed.getBottomForLineNumber(i) <= ed.scrollTop || ed.getTopForLineNumber(i) >= ed.scrollTop + 500) continue;
          const last = out.at(-1);
          if (last && last.endLineNumber === i - 1) last.endLineNumber = i;
          else out.push({ startLineNumber: i, endLineNumber: i });
        }
        return out;
      },
      getTopForPosition: (n: number) => ed.getTopForLineNumber(n),
      onDidContentSizeChange: (cb: Listener) => { ed.sizeListeners.push(cb); return { dispose() {} }; },
      onDidScrollChange: (cb: Listener) => { ed.scrollListeners.push(cb); return { dispose() {} }; },
      onMouseDown: (cb: Listener) => { inputs.push(cb); return { dispose() {} }; },
      onKeyDown: (cb: Listener) => { inputs.push(cb); return { dispose() {} }; },
      onContextMenu: (cb: Listener) => {
        menus.push(cb);
        return { dispose() {} };
      },
      onMouseUp: (cb: Listener) => {
        mouseUps.push(cb);
        return { dispose() {} };
      },
      layoutListeners: new Set<Listener>(),
      onDidLayoutChange: (cb: Listener) => { ed.layoutListeners.add(cb); return { dispose: () => ed.layoutListeners.delete(cb) }; },
      createDecorationsCollection: () => ({ set: vi.fn(), clear: vi.fn() }),
      // View zones added through the API (the hunk header rows): their place, ordinal and node, and
      // whether the editor had rendered since its last model when each was added.
      apiZones: new Map<string, { after: number; height: number; ordinal?: number; domNode: HTMLElement; renderedFirst: boolean }>(),
      renderedSinceModel: false,
      changeViewZones: (cb: (acc: { addZone(z: { afterLineNumber: number; heightInPx: number; ordinal?: number; domNode: HTMLElement }): string; removeZone(id: string): void; layoutZone(id: string): void }) => void) => {
        cb({
          addZone: (z) => {
            const id = `z${ed.apiZones.size + 1}-${Math.random()}`;
            ed.apiZones.set(id, { after: z.afterLineNumber, height: z.heightInPx, ordinal: z.ordinal, domNode: z.domNode, renderedFirst: ed.renderedSinceModel });
            return id;
          },
          removeZone: (id) => void ed.apiZones.delete(id),
          layoutZone: () => {},
        });
      },
      getSelection: vi.fn((): unknown => null),
      setPosition: vi.fn(),
      setSelection: vi.fn(),
      setScrollTop: vi.fn((top: number) => {
        const before = ed.scrollTop;
        ed.scrollTop = Math.max(0, Math.min(top, ed.getScrollHeight() - 500));
        if (ed.scrollTop !== before) ed.scrolled();
      }),
      render: vi.fn(() => { ed.renderedSinceModel = true; }),
      getLayoutInfo: () => ({ height: 500, contentLeft: 60, contentWidth: 800, verticalScrollbarWidth: 10 }),
      getOption: () => 19,
      focus: vi.fn(),
      hasTextFocus: vi.fn(() => false),
      // Monaco's find widget (plan 1C R7): `getAction('actions.find').run()`.
      findRun: vi.fn(async () => {}),
      getAction: vi.fn((id: string) => (id === 'actions.find' ? { run: ed.findRun } : null)),
      updateOptions: vi.fn(),
      setModel: vi.fn((m: never) => { ed.model = m; }),
      getValue: () => (ed.model as { text?: string } | null)?.text ?? '',
      layout: vi.fn(),
      // Shift+F10 / the ContextMenu key (fix round 1, item 1): keyed by the keybinding number, as
      // the real `addCommand` is (there is no separate "get the handler for this key" API).
      commands: new Map<number, () => void>(),
      addCommand: vi.fn((keybinding: number, handler: () => void) => { ed.commands.set(keybinding, handler); return 'cmd'; }),
      getPosition: vi.fn((): { lineNumber: number; column: number } | null => ({ lineNumber: 7, column: 1 })),
      getDomNode: vi.fn(() => domNode),
      getScrolledVisiblePosition: vi.fn((): { top: number; left: number; height: number } | null => ({ top: 30, left: 5, height: 19 })),
    };
    return ed;
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
      // A view model computes its diff on its own, attached or not (Monaco 0.57's
      // DiffEditorViewModel). `finish()` completes it; with `diffAutoUpdate` it's automatic.
      createViewModel: vi.fn((model: unknown) => {
        let finish!: () => void;
        const done = new Promise<void>((r) => { finish = r; });
        const vm = { model, computed: false, dispose: vi.fn(), waitForDiff: () => done, finish: () => { vm.computed = true; finish(); } };
        if (state.diffAutoUpdate) queueMicrotask(vm.finish);
        return vm;
      }),
      // Attaching a model reports its diff, as Monaco's onDidUpdateDiff does.
      setModel: vi.fn((vm: { model: { original: { getLineCount(): number }; modified: { getLineCount(): number } } }) => {
        original.model = vm.model.original;
        modified.model = vm.model.modified;
        original.renderedSinceModel = false;
        modified.renderedSinceModel = false;
        // A new model starts at the top, as in Monaco.
        original.scrollTop = 0;
        modified.scrollTop = 0;
        queueMicrotask(() => [...listeners].forEach((l) => l()));
      }),
      getLineChanges: () => state.lineChanges,
      updateOptions: vi.fn(),
      layout: vi.fn(),
      saveViewState: vi.fn(() => ({ saved: true })),
      restoreViewState: vi.fn(),
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
    // Not Monaco's real value (8), so a hard-coded one would fail.
    MouseTargetType: { GUTTER_VIEW_ZONE: 105, CONTENT_TEXT: 106, CONTENT_VIEW_ZONE: 108 },
    EditorOption: { lineHeight: 75 },
    createModel: (text: string, language: string) => ({ text, language, dispose: vi.fn(), getLineContent: (n: number) => text.split('\n')[n - 1], getLineMaxColumn: (n: number) => (text.split('\n')[n - 1] ?? '').length + 1, getLineCount: () => text.split('\n').length }),
  });
  const monaco = {
    editor: editor(),
    languages: { getLanguages: () => [{ id: 'plaintext' }], register: vi.fn(), setTokensProvider: vi.fn() },
    // The real numeric values (fix round 1, item 1): Shift+F10 / the ContextMenu key.
    KeyMod: { CtrlCmd: 2048, Shift: 1024, Alt: 512, WinCtrl: 256 },
    KeyCode: { ContextMenu: 58, F10: 68 },
  };
  const reset = () => {
    Object.assign(state, { defined: new Set(['vs', 'vs-dark', 'hc-black']), applied: 'vs', themeAtCreate: [], diffAutoUpdate: true, lineChanges: null, diffs: [], files: [] });
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
const copyText = vi.hoisted(() => vi.fn(async (_text: string) => {}));
vi.mock('../../api/transport', () => ({ copyText }));
vi.mock('shiki/wasm', () => ({ default: {} }));

interface FakeCodeEditor { setPosition: ReturnType<typeof vi.fn>; setSelection: ReturnType<typeof vi.fn>; apiZones: Map<string, { after: number; height: number; ordinal?: number; domNode: HTMLElement; renderedFirst: boolean }>; isHidden(n: number): boolean; collecting: boolean; pendingScroll: boolean; scrollListeners: ((e: unknown) => void)[]; getContentHeight(): number; getBottomForLineNumber(n: number): number; getTopForPosition(n: number): number; getVisibleRanges(): { startLineNumber: number; endLineNumber: number }[]; zones: { after: number; height: number }[]; hidden: [number, number][]; heights: Record<number, number>; sizeListeners: ((e: unknown) => void)[]; scrollTop: number; inputs: ((e: unknown) => void)[]; getTopForLineNumber(n: number, includeViewZones?: boolean): number; getScrollHeight(): number; menus: ((e: unknown) => void)[]; mouseUps: ((e: unknown) => void)[]; focus: ReturnType<typeof vi.fn>; hasTextFocus: ReturnType<typeof vi.fn>; getPosition: ReturnType<typeof vi.fn>; findRun: ReturnType<typeof vi.fn>; updateOptions: ReturnType<typeof vi.fn>; setModel: ReturnType<typeof vi.fn>; setScrollTop: ReturnType<typeof vi.fn>; render: ReturnType<typeof vi.fn>; layoutListeners: Set<(e: unknown) => void> }
interface FakeViewModel { model: { original: { text: string; dispose: ReturnType<typeof vi.fn> }; modified: { text: string; dispose: ReturnType<typeof vi.fn> } }; computed: boolean; dispose: ReturnType<typeof vi.fn>; finish(): void }
interface FakeState {
  defined: Set<string>;
  applied: string;
  themeAtCreate: string[];
  diffAutoUpdate: boolean;
  lineChanges: unknown;
  diffs: {
    listeners: Set<() => void>;
    original: FakeCodeEditor;
    modified: FakeCodeEditor;
    updateOptions: ReturnType<typeof vi.fn>;
    createViewModel: ReturnType<typeof vi.fn> & { mock: { results: { value: FakeViewModel }[] } };
    setModel: ReturnType<typeof vi.fn>;
    restoreViewState: ReturnType<typeof vi.fn>;
  }[];
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
// 200 lines each (the fake, as Monaco, clamps line numbers to the model).
const diffReq = (path: string, language = 'plaintext', p: typeof prefs | { mode: 'hunk' | 'split' | 'inline'; ignoreWhitespace: boolean; wordWrap: boolean } = prefs) => ({ path, original: `${path} old\n`.repeat(200), modified: `${path} new\n`.repeat(200), language, prefs: p });
const menuEvent = () => ({ target: { position: { lineNumber: 7 } }, event: { posx: 10, posy: 20, preventDefault: vi.fn() } });

// The first import of the host's module graph (host.ts, @shikijs/monaco, the theme registrations)
// is its transform: ~100 ms idle, 3 s and more under load, which the first test paid inside its own
// timeout. Paid once here, with the hook's budget; each test's fresh() then re-evaluates cached
// modules.
beforeAll(async () => { await fresh(); }, 60_000);
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

  it("Shift+F10 and the ContextMenu key open our menu at the cursor (fix round 1, item 1: onContextMenu is mouse-only)", async () => {
    const { host, state } = await fresh();
    host.attachDiff(document.createElement('div'));
    await host.showDiff(diffReq('diffed.txt'));
    const modified = state.diffs[0].modified as unknown as { commands: Map<number, () => void> };
    const shiftF10 = modified.commands.get(1024 | 68); // KeyMod.Shift | KeyCode.F10
    const contextMenuKey = modified.commands.get(58); // KeyCode.ContextMenu
    expect(shiftF10).toBeTypeOf('function');
    expect(contextMenuKey).toBeTypeOf('function');

    // No handler set: Monaco's own `editor.action.showContextMenu` is inert too while
    // `contextmenu` is false, so there's nothing to fall back to either way.
    shiftF10!();

    const handler = vi.fn();
    host.setContextMenuHandler(handler);
    shiftF10!();
    // The cursor's screen position: the editor's box (100, 200) plus its scrolled-visible
    // position (left 5, top 30, height 19) — just below the line, as a right-click would land.
    expect(handler).toHaveBeenCalledExactlyOnceWith({ path: 'diffed.txt', side: 'modified', line: 7, selection: null, selectionText: '', x: 105, y: 249 });
    handler.mockClear();
    contextMenuKey!();
    expect(handler).toHaveBeenCalledOnce();
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

  it("diffCursor() is the cursor's line on the side holding the keyboard, else the new side", async () => {
    const { host, state } = await fresh();
    expect(host.diffCursor()).toBeNull();
    host.attachDiff(document.createElement('div'));
    const d = state.diffs[0];
    d.modified.getPosition.mockReturnValue({ lineNumber: 12, column: 3 });
    d.original.getPosition.mockReturnValue({ lineNumber: 4, column: 1 });
    expect(host.diffCursor()).toEqual({ side: 'modified', line: 12 });
    d.original.hasTextFocus.mockReturnValue(true);
    expect(host.diffCursor()).toEqual({ side: 'original', line: 4 });
  });

  it("openFind() opens Monaco's find in the attached editor: the diff side holding the keyboard (else the modified one), else the file editor", async () => {
    const { host, state } = await fresh();
    host.openFind(); // nothing attached yet: a no-op
    const diffBox = document.createElement('div');
    host.attachDiff(diffBox);
    host.openFind();
    const { original, modified } = state.diffs[0];
    expect(modified.focus).toHaveBeenCalledTimes(1);
    expect(modified.findRun).toHaveBeenCalledTimes(1);
    expect(original.findRun).not.toHaveBeenCalled();
    original.hasTextFocus.mockReturnValue(true);
    host.openFind();
    expect(original.findRun).toHaveBeenCalledTimes(1);
    expect(modified.findRun).toHaveBeenCalledTimes(1);
    host.detachDiff(diffBox);
    host.attachFile(document.createElement('div'));
    host.openFind();
    expect(state.files[0].findRun).toHaveBeenCalledTimes(1);
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

  it('computes the next diff off-screen: the editor gets it only once computed, and the previous one stays until then', async () => {
    const { host, state } = await fresh();
    host.attachDiff(document.createElement('div'));
    await host.showDiff(diffReq('a.txt'));
    const ed = state.diffs[0];
    const first = ed.createViewModel.mock.results[0].value;
    expect(ed.setModel).toHaveBeenLastCalledWith(first);
    state.diffAutoUpdate = false;
    const shown = host.showDiff(diffReq('b.txt'));
    await vi.waitFor(() => expect(ed.createViewModel).toHaveBeenCalledTimes(2));
    const next = ed.createViewModel.mock.results[1].value;
    await Promise.resolve();
    // Still computing: the editor keeps the previous diff.
    expect(ed.setModel).toHaveBeenCalledTimes(1);
    expect(first.dispose).not.toHaveBeenCalled();
    next.finish();
    await shown;
    expect(ed.setModel).toHaveBeenCalledTimes(2);
    expect(ed.setModel).toHaveBeenLastCalledWith(next);
    expect(ed.setModel.mock.calls.map(([vm]) => (vm as FakeViewModel).computed)).toEqual([true, true]);
    // Drawn in the same task as the swap: a new model gets a new view, which Monaco would
    // otherwise first paint empty and fill a frame later.
    for (const side of [ed.original, ed.modified]) {
      expect(side.render).toHaveBeenLastCalledWith(true);
      expect(side.render.mock.invocationCallOrder.at(-1)).toBeGreaterThan(ed.setModel.mock.invocationCallOrder.at(-1)!);
    }
    // The previous view model and its models are released after the swap.
    expect(first.dispose).toHaveBeenCalled();
    expect(first.model.original.dispose).toHaveBeenCalled();
    expect(first.model.modified.dispose).toHaveBeenCalled();
    expect(next.dispose).not.toHaveBeenCalled();
  });

  it("re-attached for another diff, the editor hides the one it still holds until the new one is on screen (H6)", async () => {
    const { host, state } = await fresh();
    const first = document.createElement('div');
    host.attachDiff(first);
    const a = diffReq('a.txt');
    await host.showDiff(a);
    host.detachDiff(first);
    // The panel closed, and another commit's file opens in a new one: the editor still holds a.txt.
    const second = document.createElement('div');
    const b = { ...diffReq('a.txt'), modified: 'another commit\n' };
    host.attachDiff(second, b);
    const el = second.firstElementChild as HTMLElement;
    expect(el.style.visibility).toBe('hidden');
    state.diffAutoUpdate = false;
    const shown = host.showDiff(b);
    await vi.waitFor(() => expect(state.diffs[0].createViewModel).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    expect(el.style.visibility).toBe('hidden');
    state.diffs[0].createViewModel.mock.results[1].value.finish();
    await shown;
    expect(el.style.visibility).toBe('');
    // The same diff again (File View -> Diff View): what the editor holds is right, so it shows.
    host.detachDiff(second);
    const third = document.createElement('div');
    host.attachDiff(third, b);
    expect((third.firstElementChild as HTMLElement).style.visibility).toBe('');
  });

  // K7: `visibility: hidden` alone didn't hide it. Monaco's diff editor sets `visibility: visible`
  // on its two inner editors (tied to its accessible diff viewer), and a descendant's own value
  // wins over the inherited one: the old diff stayed painted. Opacity can't be undone below.
  it("the held diff is hidden in a way Monaco's inner editors can't undo: opacity 0, until the next one is on screen (K7)", async () => {
    const { host } = await fresh();
    const box = document.createElement('div');
    host.attachDiff(box);
    await host.showDiff(diffReq('a.txt'));
    const el = box.firstElementChild as HTMLElement;
    // What Monaco does to its inner editors.
    const inner = el.appendChild(document.createElement('div'));
    inner.style.visibility = 'visible';
    const b = { ...diffReq('a.txt'), modified: 'another commit\n' };
    expect(host.keepDiff(box, b)).toBe(true);
    expect(el.style.opacity).toBe('0');
    await host.showDiff(b);
    expect(el.style.opacity).toBe('');
    expect(el.style.visibility).toBe('');
    // Re-attached elsewhere for another diff, and File View's editor, the same.
    host.detachDiff(box);
    const other = document.createElement('div');
    host.attachDiff(other, { ...b, modified: 'a third\n' });
    expect((other.firstElementChild as HTMLElement).style.opacity).toBe('0');
    const fileBox = document.createElement('div');
    host.attachFile(fileBox);
    await host.showFile({ path: 'a.txt', text: 'one\n', language: 'plaintext', wordWrap: false });
    expect(host.keepFile(fileBox, { path: 'a.txt', text: 'two\n' })).toBe(true);
    expect((fileBox.firstElementChild as HTMLElement).style.opacity).toBe('0');
  });

  // Fix round 1: hidden, the held editor can't be clicked or focused (its inner editors' forced
  // `visibility: visible` would allow both); focus inside it moves to the zone around it.
  it('hidden, the held editor is inert and takes no pointer; focus inside it moves to its zone; shown, both come back', async () => {
    const { host } = await fresh();
    const zone = document.body.appendChild(document.createElement('section'));
    zone.tabIndex = -1;
    zone.dataset.focusZone = 'diff';
    const box = zone.appendChild(document.createElement('div'));
    host.attachDiff(box);
    await host.showDiff(diffReq('a.txt'));
    const el = box.firstElementChild as HTMLElement;
    const input = el.appendChild(document.createElement('textarea'));
    input.focus();
    expect(document.activeElement).toBe(input);
    const b = { ...diffReq('a.txt'), modified: 'another commit\n' };
    host.keepDiff(box, b);
    expect(el.hasAttribute('inert')).toBe(true);
    expect(el.style.pointerEvents).toBe('none');
    expect(document.activeElement).toBe(zone);
    await host.showDiff(b);
    expect(el.hasAttribute('inert')).toBe(false);
    expect(el.style.pointerEvents).toBe('');
    input.focus();
    expect(document.activeElement).toBe(input);
    zone.remove();
  });

  it('a kept panel shown again keeps its editor: keepDiff/keepFile hide what it holds unless it is the next one (J16)', async () => {
    const { host, state } = await fresh();
    const box = document.createElement('div');
    host.attachDiff(box);
    const a = diffReq('a.txt');
    await host.showDiff(a);
    const el = box.firstElementChild as HTMLElement;
    // Still in its box (the panel was hidden, not unmounted): kept, not attached again.
    expect(host.keepDiff(box, a)).toBe(true);
    expect(el.style.visibility).toBe('');
    const b = { ...diffReq('a.txt'), modified: 'another commit\n' };
    expect(host.keepDiff(box, b)).toBe(true);
    expect(el.style.visibility).toBe('hidden');
    await host.showDiff(b);
    expect(el.style.visibility).toBe('');
    expect(state.diffs).toHaveLength(1);
    // Another box: that one attaches.
    expect(host.keepDiff(document.createElement('div'), b)).toBe(false);
    // File View the same.
    const fileBox = document.createElement('div');
    host.attachFile(fileBox);
    const one = { path: 'a.txt', text: 'one\n', language: 'plaintext', wordWrap: false };
    await host.showFile(one);
    expect(host.keepFile(fileBox, { path: 'a.txt', text: 'two\n' })).toBe(true);
    expect((fileBox.firstElementChild as HTMLElement).style.visibility).toBe('hidden');
    expect(host.keepFile(document.createElement('div'), one)).toBe(false);
    expect(state.files).toHaveLength(1);
  });

  it('a box that left the document with no detach (a kept panel unmounted while hidden, J16) is let go: by the next attach, or releaseDetached', async () => {
    const { host } = await fresh();
    const unobserve = vi.spyOn(ResizeObserver.prototype, 'unobserve');
    const box = () => document.body.appendChild(document.createElement('div'));
    try {
      for (const [attach, name] of [[host.attachDiff.bind(host), 'diff'], [host.attachFile.bind(host), 'file']] as const) {
        // Hidden (its cleanup kept the editor: the box was still in the document), then unmounted:
        // no detach ever runs for it.
        const old = box();
        attach(old);
        old.remove();
        const next = box();
        attach(next);
        expect(unobserve, name).toHaveBeenCalledWith(old);
        expect(next.childElementCount, name).toBe(1);
        // Without a next attach: the view's unmount calls releaseDetached.
        const gone = box();
        attach(gone);
        gone.remove();
        unobserve.mockClear();
        host.releaseDetached();
        expect(gone.childElementCount, name).toBe(0);
        expect(unobserve, name).toHaveBeenCalledWith(gone);
        // A box still in the document (another view's, or a hidden kept one) keeps its editor.
        const shown = box();
        attach(shown);
        host.releaseDetached();
        expect(shown.childElementCount, name).toBe(1);
        shown.remove();
      }
    } finally {
      unobserve.mockRestore();
      document.body.innerHTML = '';
    }
  });

  it('a hidden box (0×0: display none) is never laid out; a shown one is (J16)', async () => {
    const { host, state } = await fresh();
    const box = document.createElement('div');
    host.attachDiff(box);
    const size = { w: 0, h: 0 };
    Object.defineProperty(box, 'clientWidth', { get: () => size.w });
    Object.defineProperty(box, 'clientHeight', { get: () => size.h });
    const layout = (state.diffs[0] as unknown as { layout: ReturnType<typeof vi.fn> }).layout;
    layout.mockClear();
    host.layout();
    expect(layout).not.toHaveBeenCalled();
    Object.assign(size, { w: 800, h: 600 });
    host.layout();
    expect(layout).toHaveBeenCalledExactlyOnceWith({ width: 800, height: 600 });
  });

  it('a show that fails un-hides the editor (its error UI shows over it, and a Retry can show into it)', async () => {
    const { host } = await fresh();
    const first = document.createElement('div');
    host.attachDiff(first);
    host.attachFile(document.createElement('div'));
    await host.showDiff(diffReq('a.txt'));
    await host.showFile({ path: 'a.txt', text: 'one\n', language: 'plaintext', wordWrap: false });
    host.detachDiff(first);
    const second = document.createElement('div');
    const b = diffReq('b.php', 'php');
    host.attachDiff(second, b);
    const el = second.firstElementChild as HTMLElement;
    expect(el.style.visibility).toBe('hidden');
    gate.wait = Promise.reject(new Error('grammar failed'));
    gate.wait.catch(() => {});
    await expect(host.showDiff(b)).rejects.toThrow('grammar failed');
    expect(el.style.visibility).toBe('');
    // File View too.
    const file = document.createElement('div');
    const next = { path: 'b.rs', text: 'fn main() {}\n', language: 'rust', wordWrap: false };
    host.attachFile(file, next);
    expect((file.firstElementChild as HTMLElement).style.visibility).toBe('hidden');
    await expect(host.showFile(next)).rejects.toThrow('grammar failed');
    expect((file.firstElementChild as HTMLElement).style.visibility).toBe('');
  });

  it('showFile of the same path and text keeps the model (a save keeps the undo history)', async () => {
    const { host, state } = await fresh();
    host.attachFile(document.createElement('div'));
    const req = { path: 'a.txt', text: 'one\n', language: 'plaintext', wordWrap: false };
    await host.showFile(req);
    await host.showFile(req);
    expect(state.files[0].setModel).toHaveBeenCalledTimes(1);
    await host.showFile({ ...req, text: 'two\n' });
    expect(state.files[0].setModel).toHaveBeenCalledTimes(2);
  });

  it('re-attached for another file, File View hides the one it still holds until the new one is shown (H6)', async () => {
    const { host } = await fresh();
    const first = document.createElement('div');
    host.attachFile(first);
    await host.showFile({ path: 'a.txt', text: 'one\n', language: 'plaintext', wordWrap: false });
    host.detachFile(first);
    const second = document.createElement('div');
    const next = { path: 'a.txt', text: 'two\n', language: 'plaintext', wordWrap: false };
    host.attachFile(second, next);
    const el = second.firstElementChild as HTMLElement;
    expect(el.style.visibility).toBe('hidden');
    await host.showFile(next);
    expect(el.style.visibility).toBe('');
    host.detachFile(second);
    const third = document.createElement('div');
    host.attachFile(third, next);
    expect((third.firstElementChild as HTMLElement).style.visibility).toBe('');
  });

  it('sticky scroll is off in both editors, and its setting applies in place (H7)', async () => {
    const { host, state } = await fresh();
    host.attachDiff(document.createElement('div'));
    host.attachFile(document.createElement('div'));
    await host.showDiff(diffReq('a.txt'));
    expect(state.diffs[0].updateOptions).toHaveBeenLastCalledWith(expect.objectContaining({ stickyScroll: { enabled: false } }));
    const { useEditorSettings } = await import('../editorSettings');
    useEditorSettings.getState().set({ stickyScroll: true });
    expect(state.diffs[0].updateOptions).toHaveBeenLastCalledWith({ stickyScroll: { enabled: true } });
    expect(state.files[0].updateOptions).toHaveBeenLastCalledWith({ stickyScroll: { enabled: true } });
    await host.showDiff(diffReq('b.txt'));
    expect(state.diffs[0].updateOptions).toHaveBeenLastCalledWith(expect.objectContaining({ stickyScroll: { enabled: true } }));
    useEditorSettings.getState().set({ stickyScroll: false });
    localStorage.clear();
  });

  it('a newer showDiff drops one still computing: never shown, and disposed', async () => {
    const { host, state } = await fresh();
    host.attachDiff(document.createElement('div'));
    state.diffAutoUpdate = false;
    const older = host.showDiff(diffReq('a.txt'));
    await vi.waitFor(() => expect(state.diffs[0].createViewModel).toHaveBeenCalledTimes(1));
    state.diffAutoUpdate = true;
    await host.showDiff(diffReq('b.txt'));
    const [stale, current] = state.diffs[0].createViewModel.mock.results.map((r) => r.value);
    stale.finish();
    await older;
    expect(state.diffs[0].setModel.mock.calls).toEqual([[current]]);
    expect(stale.dispose).toHaveBeenCalled();
    expect(stale.model.original.dispose).toHaveBeenCalled();
    expect(stale.model.modified.dispose).toHaveBeenCalled();
  });

  // K7 (↑/↓ through crlf.txt, data.bin, ünï.txt): crlf.txt's show still computing when its view
  // went (a binary's message replaced it), ünï.txt's view attaches (hiding what the editor holds)
  // and its own show only starts a moment later, in a passive effect. crlf.txt's result landing in
  // between showed it, un-hidden, under ünï.txt's header.
  it("an attach drops a show still in flight: the previous view's diff never lands, un-hidden, under the attaching one (K7)", async () => {
    const { host, state } = await fresh();
    const first = document.createElement('div');
    host.attachDiff(first);
    await host.showDiff(diffReq('a.txt'));
    state.diffAutoUpdate = false;
    const older = host.showDiff(diffReq('crlf.txt'));
    await vi.waitFor(() => expect(state.diffs[0].createViewModel).toHaveBeenCalledTimes(2));
    host.detachDiff(first);
    const second = document.createElement('div');
    const next = diffReq('ünï.txt');
    host.attachDiff(second, next);
    const el = second.firstElementChild as HTMLElement;
    expect(el.style.opacity).toBe('0');
    const stale = state.diffs[0].createViewModel.mock.results[1].value;
    stale.finish();
    await older;
    expect(el.style.opacity).toBe('0');
    expect(state.diffs[0].setModel).not.toHaveBeenCalledWith(stale);
    expect(stale.dispose).toHaveBeenCalled();
    state.diffAutoUpdate = true;
    await host.showDiff(next);
    expect(el.style.opacity).toBe('');
    // File View too.
    const box = document.createElement('div');
    host.attachFile(box);
    await host.showFile({ path: 'a.txt', text: 'one\n', language: 'plaintext', wordWrap: false });
    let release!: () => void;
    gate.wait = new Promise<void>((r) => { release = r; });
    const olderFile = host.showFile({ path: 'b.rs', text: 'fn b() {}\n', language: 'rust', wordWrap: false });
    host.detachFile(box);
    const other = document.createElement('div');
    host.attachFile(other, { path: 'c.txt', text: 'three\n' });
    const fileEl = other.firstElementChild as HTMLElement;
    release();
    await olderFile;
    expect(fileEl.style.opacity).toBe('0');
    expect(state.files[0].setModel).not.toHaveBeenCalledWith(expect.objectContaining({ text: 'fn b() {}\n' }));
    await host.showFile({ path: 'c.txt', text: 'three\n', language: 'plaintext', wordWrap: false });
    expect(state.files[0].setModel).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'three\n' }));
    expect(fileEl.style.opacity).toBe('');
  });

  it('a new diff opens with its first change centred, in every mode, the cursor on it; at the top when it shows there whole', async () => {
    const { host, state } = await fresh();
    host.attachDiff(document.createElement('div'));
    const m = () => state.diffs[0].modified;
    // Line 120 (2261-2280 px) centred in the 500 px view.
    state.lineChanges = [{ originalStartLineNumber: 120, originalEndLineNumber: 120, modifiedStartLineNumber: 120, modifiedEndLineNumber: 120 }];
    await host.showDiff(diffReq('a.txt'));
    expect(m().scrollTop).toBe(2270.5 - 250);
    expect(m().setPosition).toHaveBeenLastCalledWith({ lineNumber: 120, column: 1 });
    // A deletion only: Monaco reports the line above it. Its removed lines (the original side's
    // 150-152, 2831-2888 px) are the change; the cursor goes to the line below them.
    state.lineChanges = [{ originalStartLineNumber: 150, originalEndLineNumber: 152, modifiedStartLineNumber: 149, modifiedEndLineNumber: 0 }];
    await host.showDiff(diffReq('b.txt', 'plaintext', { mode: 'split', ignoreWhitespace: false, wordWrap: false }));
    expect(m().scrollTop).toBe(2859.5 - 250);
    expect(m().setPosition).toHaveBeenLastCalledWith({ lineNumber: 150, column: 1 });
    // Once per presentation: a prefs change keeps the place.
    const kept = m().scrollTop;
    host.setDiffPrefs({ mode: 'inline', ignoreWhitespace: false, wordWrap: false });
    expect(m().scrollTop).toBe(kept);
    // Hunk too.
    state.lineChanges = [{ originalStartLineNumber: 120, originalEndLineNumber: 120, modifiedStartLineNumber: 120, modifiedEndLineNumber: 120 }];
    await host.showDiff(diffReq('c.txt', 'plaintext', { mode: 'hunk', ignoreWhitespace: false, wordWrap: false }));
    expect(m().scrollTop).toBe(2270.5 - 250);
    // Whole on the first screen (500 px, 19 px lines: lines 1-26): at the top.
    state.lineChanges = [{ originalStartLineNumber: 25, originalEndLineNumber: 26, modifiedStartLineNumber: 25, modifiedEndLineNumber: 26 }];
    await host.showDiff(diffReq('d.txt'));
    expect(m().scrollTop).toBe(0);
    expect(m().setPosition).toHaveBeenLastCalledWith({ lineNumber: 25, column: 1 });
    // One line further, it would be cut: centred.
    state.lineChanges = [{ originalStartLineNumber: 26, originalEndLineNumber: 27, modifiedStartLineNumber: 26, modifiedEndLineNumber: 27 }];
    await host.showDiff(diffReq('e.txt'));
    expect(m().scrollTop).toBe(494 - 250);
    // No change: nothing moves the cursor.
    const moves = m().setPosition.mock.calls.length;
    state.lineChanges = [];
    await host.showDiff(diffReq('f.txt'));
    expect(m().scrollTop).toBe(0);
    expect(m().setPosition).toHaveBeenCalledTimes(moves);
  });

  it("the open's place is held through late relayouts (zones, wrapped lines, the editor's size) until the user takes over", async () => {
    const { host, state } = await fresh();
    const el = document.createElement('div');
    host.attachDiff(el);
    const { modified: m, original: o } = state.diffs[0];
    state.lineChanges = [{ originalStartLineNumber: 120, originalEndLineNumber: 120, modifiedStartLineNumber: 120, modifiedEndLineNumber: 120 }];
    await host.showDiff(diffReq('a.txt'));
    const flush = () => new Promise<void>((r) => setTimeout(r, 0));
    await flush(); // the new model's onDidUpdateDiff
    const centred = () => m.scrollTop + 250 === m.getTopForLineNumber(120) + 9.5;
    expect(centred()).toBe(true);
    // A zone lands above the change (Monaco's restore keeps the top line: the change moves down).
    // The original side is laid out level with it, as Monaco aligns the two.
    m.zones = o.zones = [{ after: 50, height: 57 }];
    m.sizeListeners.forEach((l) => l({}));
    await flush();
    expect(centred()).toBe(true);
    // Lines above it wrap later still, and Monaco moves the view itself.
    m.heights = o.heights = { 60: 38, 61: 38 };
    m.scrollTop += 7;
    m.scrollListeners.forEach((l) => l({ scrollTopChanged: true }));
    await flush();
    expect(centred()).toBe(true);
    // The user takes over (a wheel): a later relayout is Monaco's alone.
    el.firstElementChild!.dispatchEvent(new Event('wheel', { bubbles: true }));
    m.zones = o.zones = [{ after: 50, height: 114 }];
    m.sizeListeners.forEach((l) => l({}));
    await flush();
    expect(centred()).toBe(false);
  });

  it("a save's reload keeps its view: no jump to the first change, and nothing held", async () => {
    const { host, state } = await fresh();
    host.attachDiff(document.createElement('div'));
    const m = state.diffs[0].modified;
    state.lineChanges = [{ originalStartLineNumber: 120, originalEndLineNumber: 120, modifiedStartLineNumber: 120, modifiedEndLineNumber: 120 }];
    await host.showDiff(diffReq('a.txt'));
    host.keepViewOnNextShow();
    await host.showDiff({ ...diffReq('a.txt'), modified: 'edited\n'.repeat(200) });
    expect(state.diffs[0].restoreViewState).toHaveBeenCalledWith({ saved: true });
    // The fake's restore doesn't scroll: the new model's top stays, and a relayout doesn't reveal.
    expect(m.scrollTop).toBe(0);
    m.sizeListeners.forEach((l) => l({}));
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(m.scrollTop).toBe(0);
  });

  it("a diff opened at a line (a note's file:line) centres that line, not the first change, the cursor on it in its side; held through relayouts", async () => {
    const { host, state } = await fresh();
    host.attachDiff(document.createElement('div'));
    const { modified: m, original: o } = state.diffs[0];
    const flush = () => new Promise<void>((r) => setTimeout(r, 0));
    state.lineChanges = [{ originalStartLineNumber: 120, originalEndLineNumber: 120, modifiedStartLineNumber: 120, modifiedEndLineNumber: 120 }];
    // New line 92 (1729-1748 px) centred in the 500 px view.
    await host.showDiff({ ...diffReq('a.txt'), line: { side: 'modified', line: 92 } });
    await flush();
    expect(m.scrollTop).toBe(1738.5 - 250);
    expect(m.setPosition).toHaveBeenLastCalledWith({ lineNumber: 92, column: 1 });
    // A zone lands above it later: the line stays centred.
    m.zones = o.zones = [{ after: 50, height: 57 }];
    m.sizeListeners.forEach((l) => l({}));
    await flush();
    expect(m.scrollTop).toBe(1738.5 + 57 - 250);
    m.zones = o.zones = [];
    // An old line (Split's left side), in a deletion: the cursor goes to the original side.
    state.lineChanges = [{ originalStartLineNumber: 150, originalEndLineNumber: 152, modifiedStartLineNumber: 149, modifiedEndLineNumber: 0 }];
    const moves = m.setPosition.mock.calls.length;
    await host.showDiff({ ...diffReq('b.txt', 'plaintext', { mode: 'split', ignoreWhitespace: false, wordWrap: false }), line: { side: 'original', line: 151 } });
    expect(m.scrollTop).toBe(2859.5 - 250);
    expect(o.setPosition).toHaveBeenLastCalledWith({ lineNumber: 151, column: 1 });
    expect(m.setPosition).toHaveBeenCalledTimes(moves);
    // Past the file's end (it changed since the note): its last line.
    await host.showDiff({ ...diffReq('c.txt'), line: { side: 'modified', line: 900 } });
    expect(m.setPosition).toHaveBeenLastCalledWith({ lineNumber: 201, column: 1 });
    // Without a line, a new diff opens at its first change again.
    state.lineChanges = [{ originalStartLineNumber: 120, originalEndLineNumber: 120, modifiedStartLineNumber: 120, modifiedEndLineNumber: 120 }];
    await host.showDiff(diffReq('d.txt'));
    expect(m.scrollTop).toBe(2270.5 - 250);
    expect(m.setPosition).toHaveBeenLastCalledWith({ lineNumber: 120, column: 1 });
  });

  it("a diff opened at a range (a note's file:start-end) selects its lines in its side, the cursor on the first, the range centred; held through relayouts", async () => {
    const { host, state } = await fresh();
    host.attachDiff(document.createElement('div'));
    const { modified: m, original: o } = state.diffs[0];
    const flush = () => new Promise<void>((r) => setTimeout(r, 0));
    state.lineChanges = [{ originalStartLineNumber: 120, originalEndLineNumber: 120, modifiedStartLineNumber: 120, modifiedEndLineNumber: 120 }];
    // New lines 100-105 (1881-1995 px) centred in the 500 px view; "a.txt new" ends at column 10.
    await host.showDiff({ ...diffReq('a.txt'), line: { side: 'modified', line: 100, end: 105 } });
    await flush();
    expect(m.scrollTop).toBe(1938 - 250);
    expect(m.setSelection).toHaveBeenLastCalledWith({ selectionStartLineNumber: 105, selectionStartColumn: 10, positionLineNumber: 100, positionColumn: 1 });
    // A zone lands above it later: the range stays centred.
    m.zones = o.zones = [{ after: 50, height: 57 }];
    m.sizeListeners.forEach((l) => l({}));
    await flush();
    expect(m.scrollTop).toBe(1938 + 57 - 250);
    m.zones = o.zones = [];
    // Taller than the view: its first line at the top, below three lines of context.
    await host.showDiff({ ...diffReq('b.txt'), line: { side: 'modified', line: 10, end: 80 } });
    expect(m.scrollTop).toBe(171 - 57);
    expect(m.setSelection).toHaveBeenLastCalledWith(expect.objectContaining({ selectionStartLineNumber: 80, positionLineNumber: 10 }));
    // Old lines (Split's left side), in a deletion: selected in the original side.
    state.lineChanges = [{ originalStartLineNumber: 150, originalEndLineNumber: 152, modifiedStartLineNumber: 149, modifiedEndLineNumber: 0 }];
    const selections = m.setSelection.mock.calls.length;
    await host.showDiff({ ...diffReq('c.txt', 'plaintext', { mode: 'split', ignoreWhitespace: false, wordWrap: false }), line: { side: 'original', line: 150, end: 152 } });
    expect(m.scrollTop).toBe(2859.5 - 250);
    expect(o.setSelection).toHaveBeenLastCalledWith({ selectionStartLineNumber: 152, selectionStartColumn: 10, positionLineNumber: 150, positionColumn: 1 });
    expect(m.setSelection).toHaveBeenCalledTimes(selections);
    // Past the file's end (it changed since the note): to its last line.
    await host.showDiff({ ...diffReq('d.txt'), line: { side: 'modified', line: 195, end: 900 } });
    expect(m.setSelection).toHaveBeenLastCalledWith(expect.objectContaining({ selectionStartLineNumber: 201, positionLineNumber: 195 }));
  });

  it('Next/Previous change go by the scroll: on from the change the view was put on, else from the centre line', async () => {
    const { host, state } = await fresh();
    const el = document.createElement('div');
    host.attachDiff(el);
    const m = state.diffs[0].modified;
    const at = (line: number) => ({ originalStartLineNumber: line, originalEndLineNumber: line, modifiedStartLineNumber: line, modifiedEndLineNumber: line });
    state.lineChanges = [at(30), at(100), at(190)];
    await host.showDiff(diffReq('a.txt'));
    const centredOn = (line: number) => m.scrollTop + 250 === m.getTopForLineNumber(line) + 9.5;
    const cursor = () => (m.setPosition.mock.lastCall?.[0] as { lineNumber: number }).lineNumber;
    expect(centredOn(30)).toBe(true);
    // Opened on the first change: Next is the second.
    host.goToChange('next');
    expect(centredOn(100)).toBe(true);
    expect(cursor()).toBe(100);
    host.goToChange('next');
    expect(centredOn(190)).toBe(true);
    host.goToChange('previous');
    expect(centredOn(100)).toBe(true);
    // The user scrolls back to the top: Next is the first change below the centre line.
    const scrollTo = (top: number) => {
      el.firstElementChild!.dispatchEvent(new Event('wheel', { bubbles: true }));
      m.scrollTop = top;
    };
    scrollTo(0);
    host.goToChange('next');
    expect(centredOn(30)).toBe(true);
    expect(cursor()).toBe(30);
    // To the end: Previous is the last change above the centre line, not one before the cursor.
    scrollTo(3781);
    host.goToChange('previous');
    expect(centredOn(190)).toBe(true);
    // Between changes 1 and 2 (the centre at line 140): Next is 190, Previous 100.
    scrollTo(m.getTopForLineNumber(140) - 250);
    host.goToChange('next');
    expect(centredOn(190)).toBe(true);
    scrollTo(m.getTopForLineNumber(140) - 250);
    host.goToChange('previous');
    expect(centredOn(100)).toBe(true);
    // Past the last, it wraps to the first.
    host.goToChange('next');
    host.goToChange('next');
    expect(centredOn(30)).toBe(true);
  });

  it("a mode switch that keeps a line, not the change, isn't on that change any more, even at the same scroll", async () => {
    const { host, state } = await fresh();
    const el = document.createElement('div');
    host.attachDiff(el);
    const m = state.diffs[0].modified;
    const at = (line: number) => ({ originalStartLineNumber: line, originalEndLineNumber: line, modifiedStartLineNumber: line, modifiedEndLineNumber: line });
    // Hunk shows its first change on the first screen: the view opens at the top.
    state.lineChanges = [at(25), at(100)];
    await host.showDiff(diffReq('a.txt', 'plaintext', { mode: 'hunk', ignoreWhitespace: false, wordWrap: false }));
    expect(m.scrollTop).toBe(0);
    // A click, then Inline, where the change is further down (the fake's layout doesn't change, so
    // the place kept is the top). Next goes to the first change below the centre line.
    el.firstElementChild!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    state.lineChanges = [at(40), at(100)];
    host.setDiffPrefs(prefs);
    host.goToChange('next');
    expect(m.setPosition).toHaveBeenLastCalledWith({ lineNumber: 40, column: 1 });
  });

  it("Hunk mode's header rows are laid out with the diff, before it renders; Inline and Split have none (spec #2 §7.3)", async () => {
    const { host, state } = await fresh();
    host.attachDiff(document.createElement('div'));
    const placed = vi.fn();
    let release!: (z: { after: number }[]) => void;
    const zones = new Promise<{ after: number }[]>((r) => { release = r; });
    const hunk = { mode: 'hunk', ignoreWhitespace: false, wordWrap: false } as const;
    const shown = host.showDiff({ ...diffReq('a.txt', 'plaintext', hunk), hunkZones: { zones, placed } });
    // The diff waits for its rows: nothing is attached until they're in.
    await new Promise((r) => setTimeout(r, 0));
    expect(state.diffs[0].setModel).not.toHaveBeenCalled();
    release([{ after: 1 }, { after: 16 }]);
    await shown;
    const mod = state.diffs[0].modified;
    const rows = [...mod.apiZones.values()];
    expect(rows.map((z) => [z.after, z.height, z.renderedFirst])).toEqual([[1, 24, false], [16, 24, false]]);
    // After Monaco's own zones at the same line (the "N hidden lines" bar).
    expect(rows.every((z) => (z.ordinal ?? 0) > 10000)).toBe(true);
    const nodes = placed.mock.lastCall?.[0] as HTMLElement[];
    expect(nodes.map((n) => [n.className, n.parentElement?.className])).toEqual([['hunk-row', 'hunk-zone'], ['hunk-row', 'hunk-zone']]);
    expect(nodes[0].parentElement?.style.minWidth).toBe('786px');
    // Inline and Split: no rows between lines; back in Hunk, they're laid out again.
    host.setDiffPrefs({ ...hunk, mode: 'split' });
    expect(mod.apiZones.size).toBe(0);
    expect(placed).toHaveBeenLastCalledWith([]);
    host.setDiffPrefs(hunk);
    expect(mod.apiZones.size).toBe(2);
    expect(placed.mock.lastCall?.[0]).toHaveLength(2);
    // A show without rows (another diff) clears them.
    await host.showDiff(diffReq('b.txt', 'plaintext', hunk));
    expect(mod.apiZones.size).toBe(0);
  });

  it('review cards (spec 2026-10-08 §2): laid with the diff before it renders, its own file only, in a layer beside the editor; Split moves an old-side card to the old editor', async () => {
    const { host, state } = await fresh();
    const box = document.createElement('div');
    host.attachDiff(box);
    const placed = vi.fn();
    host.setReviewZones({ path: 'a.txt', items: [{ key: 't:1', side: 'modified', line: 4, startLine: null, stop: true }, { key: 'd:2', side: 'original', line: 9, startLine: null, stop: true }], placed });
    // Outside Monaco's own element (and its key handling): beside it in the view's box.
    expect(box.querySelector(':scope > .review-layer')).not.toBeNull();
    expect(box.querySelector('.monaco-host .review-layer')).toBeNull();
    // Old line 9 was deleted: Inline shows it in the block after new line 8.
    state.lineChanges = [{ originalStartLineNumber: 9, originalEndLineNumber: 9, modifiedStartLineNumber: 8, modifiedEndLineNumber: 0 }];
    await host.showDiff(diffReq('a.txt'));
    const { original, modified } = state.diffs[0];
    expect([...modified.apiZones.values()].map((z) => [z.after, z.renderedFirst, (z.ordinal ?? 0) > 10001])).toEqual([[4, false, true], [8, false, true]]);
    expect([...(placed.mock.lastCall?.[0] as Map<string, HTMLElement>).keys()]).toEqual(['t:1', 'd:2']);
    host.setDiffPrefs({ ...prefs, mode: 'split' });
    expect([...modified.apiZones.values()].map((z) => z.after)).toEqual([4]);
    expect([...original.apiZones.values()].map((z) => z.after)).toEqual([9]);
    // Another file: none of these cards.
    await host.showDiff(diffReq('b.txt'));
    expect(modified.apiZones.size + original.apiZones.size).toBe(0);
    expect(host.goToReviewZone('next')).toBeNull();
    host.setReviewZones(null);
  });

  it('no review: its layer, zones and listeners leave the shared editor, so later diffs carry none of it; the next review brings them back', async () => {
    const { host, state } = await fresh();
    const box = document.createElement('div');
    host.attachDiff(box);
    await host.showDiff(diffReq('a.txt'));
    const { original, modified } = state.diffs[0];
    const listening = () => original.layoutListeners.size + modified.layoutListeners.size;
    const before = listening();
    host.setReviewZones({ path: 'a.txt', items: [{ key: 't:1', side: 'modified', line: 4, startLine: null, stop: true }], placed: vi.fn() });
    expect(box.querySelector(':scope > .review-layer')).not.toBeNull();
    expect(modified.apiZones.size).toBe(1);
    expect(listening()).toBe(before + 2);
    host.setReviewZones(null);
    expect(box.querySelector('.review-layer')).toBeNull();
    expect(modified.apiZones.size).toBe(0);
    expect(listening()).toBe(before);
    // Another diff (a commit's), then another review.
    await host.showDiff(diffReq('b.txt'));
    expect(box.querySelector('.review-layer')).toBeNull();
    host.setReviewZones({ path: 'b.txt', items: [{ key: 't:2', side: 'modified', line: 1, startLine: null, stop: true }], placed: vi.fn() });
    expect(box.querySelector(':scope > .review-layer')).not.toBeNull();
    expect(modified.apiZones.size).toBe(1);
    host.setReviewZones(null);
  });

  it('review cards hide and show with the diff they are over: re-attached for another diff, they wait for it too (H6)', async () => {
    const { host } = await fresh();
    const first = document.createElement('div');
    host.attachDiff(first);
    await host.showDiff(diffReq('a.txt'));
    host.setReviewZones({ path: 'a.txt', items: [], placed: vi.fn() });
    host.detachDiff(first);
    const second = document.createElement('div');
    const b = { ...diffReq('a.txt'), modified: 'another commit\n' };
    host.attachDiff(second, b);
    const layer = second.querySelector<HTMLElement>(':scope > .review-layer')!;
    expect([layer.style.visibility, layer.hasAttribute('inert')]).toEqual(['hidden', true]);
    await host.showDiff(b);
    expect([layer.style.visibility, layer.hasAttribute('inert')]).toEqual(['', false]);
    host.setReviewZones(null);
  });

  it("diffLines() is the selection's lines on the side holding the keyboard, else the cursor's; diffLineText() reads a side's lines", async () => {
    const { host, state } = await fresh();
    expect(host.diffLines()).toBeNull();
    host.attachDiff(document.createElement('div'));
    await host.showDiff(diffReq('a.txt'));
    const m = state.diffs[0].modified as unknown as { getSelection: ReturnType<typeof vi.fn> };
    // A selection ending at column 1 of a line covers the lines above it only.
    m.getSelection.mockReturnValue({ startLineNumber: 3, endLineNumber: 6, endColumn: 1 });
    expect(host.diffLines()).toEqual({ side: 'modified', start: 3, end: 5 });
    m.getSelection.mockReturnValue({ startLineNumber: 7, endLineNumber: 7, endColumn: 4 });
    expect(host.diffLines()).toEqual({ side: 'modified', start: 7, end: 7 });
    // Split's old editor holding the keyboard: its selection, on the old side.
    const o = state.diffs[0].original as unknown as { getSelection: ReturnType<typeof vi.fn>; hasTextFocus: ReturnType<typeof vi.fn> };
    o.hasTextFocus.mockReturnValue(true);
    o.getSelection.mockReturnValue({ startLineNumber: 2, endLineNumber: 4, endColumn: 9 });
    expect(host.diffLines()).toEqual({ side: 'original', start: 2, end: 4 });
    expect(host.diffLineText('original', 1, 2)).toEqual(['a.txt old', 'a.txt old']);
  });

  it('a click on a deleted line (Inline, Hunk) copies it, Shift+click the whole deleted block; with a toast', async () => {
    const { host, state } = await fresh();
    const { useToast } = await import('../../ui/toastStore');
    host.attachDiff(document.createElement('div'));
    // Line 3 changed (its old text shows in a zone after line 2); lines 6-8 deleted (a zone after
    // line 5). Line 6 is wrapped: two rendered segments.
    state.lineChanges = [
      { originalStartLineNumber: 3, originalEndLineNumber: 3, modifiedStartLineNumber: 3, modifiedEndLineNumber: 3 },
      { originalStartLineNumber: 6, originalEndLineNumber: 8, modifiedStartLineNumber: 5, modifiedEndLineNumber: 0 },
    ];
    await host.showDiff({ path: 'f.txt', original: 'a\nb\nc\nd\ne\nlong line\there\n\nf3\ng\n', modified: 'a\nb\nC\nd\ne\ng\n', language: 'plaintext', prefs });
    const zone = (segments: string[]) => {
      const z = document.createElement('div');
      z.className = 'view-lines line-delete';
      z.innerHTML = segments.map((t) => `<div class="view-line"><span>${t.replaceAll(' ', '&nbsp;')}</span></div>`).join('');
      return [...z.querySelectorAll('.view-line span')];
    };
    const up = (element: Element, afterLineNumber: number, opts: { shiftKey?: boolean; type?: number; leftButton?: boolean } = {}) =>
      state.diffs[0].modified.mouseUps[0]({ target: { type: opts.type ?? 108, element, detail: { afterLineNumber } }, event: { leftButton: opts.leftButton ?? true, shiftKey: !!opts.shiftKey } });
    const block = zone(['long line', '    here', '', 'f3']);
    const copied = () => copyText.mock.calls.map(([t]) => t);

    up(block[1], 5);
    up(block[3], 5);
    up(block[2], 5);
    up(zone(['c'])[0], 2);
    expect(copied()).toEqual(['long line\there', 'f3', '', 'c']);
    await vi.waitFor(() => expect(useToast.getState().message).toBe('Copied 1 line'));
    // Shift+click extends the page's selection first; it still copies the block, and drops that.
    const extended = document.createRange();
    extended.selectNodeContents(block[0]);
    getSelection()!.addRange(extended);
    // Monaco extended its own selection too (Shift+mousedown): collapsed back to its anchor.
    const modified = state.diffs[0].modified as unknown as { getSelection: ReturnType<typeof vi.fn>; setPosition: ReturnType<typeof vi.fn> };
    modified.getSelection.mockReturnValueOnce({ selectionStartLineNumber: 3, selectionStartColumn: 2, isEmpty: () => false });
    up(block[0], 5, { shiftKey: true });
    expect(copied().at(-1)).toBe('long line\there\n\nf3');
    expect(getSelection()!.rangeCount).toBe(0);
    expect(modified.setPosition).toHaveBeenCalledWith({ lineNumber: 3, column: 2 });
    await vi.waitFor(() => expect(useToast.getState().message).toBe('Copied 3 lines'));

    // Not a click on deleted text: the gutter (type 5), text (type 6), a right click, or the end of
    // a drag that selected text (Monaco copies a selection in the zone itself).
    copyText.mockClear();
    up(block[0], 5, { type: 105 });
    up(block[0], 5, { type: 106 });
    up(block[0], 5, { leftButton: false });
    document.body.append(block[0].closest('.line-delete')!);
    const range = document.createRange();
    range.selectNodeContents(block[0]);
    getSelection()!.addRange(range);
    up(block[0], 5);
    getSelection()!.removeAllRanges();
    expect(copyText).not.toHaveBeenCalled();
  });

  describe('a mode or toggle change keeps the line at the viewport centre there', () => {
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    // 200 lines; lines 150-152 deleted (inline: a 57 px zone after modified line 149).
    const deletion = { originalStartLineNumber: 150, originalEndLineNumber: 152, modifiedStartLineNumber: 149, modifiedEndLineNumber: 0 };
    async function shown(mode: 'inline' | 'split' | 'hunk', ignoreWhitespace = false) {
      const { host, state } = await fresh();
      const el = document.createElement('div');
      host.attachDiff(el);
      state.lineChanges = [deletion];
      await host.showDiff({ path: 'f.txt', original: lines(200), modified: lines(197), language: 'plaintext', prefs: { ...prefs, mode, ignoreWhitespace } });
      const [ed] = state.diffs;
      // Somewhere inside the diff editor's DOM (a scrollbar, a line, the minimap).
      const inside = el.firstElementChild!.appendChild(document.createElement('div'));
      return { host, state, ed, el, inside, m: ed.modified, o: ed.original };
    }
    /** The user, by input: a pointer (scrollbar drags included), the wheel, or a key. */
    const user = (inside: Element, e: Event = new Event('pointerdown', { bubbles: true })) => inside.dispatchEvent(e);
    const centre = (e: FakeCodeEditor) => e.scrollTop + 250;
    const split = { mode: 'split', ignoreWhitespace: false, wordWrap: false } as const;
    const flush = () => new Promise<void>((r) => setTimeout(r, 0));
    const diffDone = (state: FakeState) => [...state.diffs[0].listeners].forEach((l) => l());

    /**
     * What Monaco's DiffEditorWidget does when view zones change (applyViewZones): capture a
     * StableEditorScrollState of the modified editor (its first visible line and the offset into
     * it), change the layout, fire onDidContentSizeChange from inside, then restore the state
     * (scroll so that first visible line keeps its offset). Monaco's own code, not ours: any
     * scroll we make from inside the event is undone by that restore.
     */
    function relayout(m: FakeCodeEditor, change: () => void) {
      const scrollTop = m.scrollTop;
      const contentHeight = m.getContentHeight();
      const first = scrollTop === 0 ? null : (m.getVisibleRanges()[0]?.startLineNumber ?? null);
      const delta = first === null ? 0 : scrollTop - m.getTopForPosition(first);
      change();
      m.sizeListeners.forEach((l) => l({}));
      if (contentHeight === m.getContentHeight() && scrollTop === m.scrollTop) return;
      if (first !== null) (m.setScrollTop as unknown as (top: number) => void)(m.getTopForPosition(first) + delta);
    }

    /**
     * What Monaco's ViewModel does when hidden areas (Hunk's collapsed regions: setHiddenAreas) or
     * line breaks (word wrap: _onConfigurationChanged) change: inside beginEmitViewEvents, change
     * the layout and recover the viewport start (scroll so its first line keeps its offset, unless
     * that line is now hidden). The outgoing events wait for endEmitViewEvents, so the content-size
     * event arrives with the scroll position already moved, by Monaco, not the user.
     */
    function viewModelChange(m: FakeCodeEditor, change: () => void) {
      const contentHeight = m.getContentHeight();
      const first = m.scrollTop === 0 ? null : (m.getVisibleRanges()[0]?.startLineNumber ?? null);
      const delta = first === null ? 0 : m.scrollTop - m.getTopForPosition(first);
      m.collecting = true;
      change();
      if (first !== null && !m.isHidden(first)) (m.setScrollTop as unknown as (top: number) => void)(m.getTopForPosition(first) + delta);
      m.collecting = false;
      if (contentHeight !== m.getContentHeight()) m.sizeListeners.forEach((l) => l({}));
      if (m.pendingScroll) {
        m.pendingScroll = false;
        m.scrollListeners.forEach((l) => l({ scrollTopChanged: true }));
      }
    }

    it('a modified line at the centre stays there, sub-line offset included, whatever the new layout', async () => {
      const { host, ed, m } = await shown('inline');
      m.scrollTop = m.getTopForLineNumber(100) + 5 - 250;
      // Split: an alignment zone above line 50 moves everything below it down.
      ed.updateOptions.mockImplementationOnce(() => relayout(m, () => { m.zones = [{ after: 49, height: 57 }]; }));
      host.setDiffPrefs(split);
      await flush();
      expect(centre(m)).toBe(m.getTopForLineNumber(100) + 5);
    });

    it('in a deleted-lines zone, it anchors on the original line (through the original editor) and finds it on the other side', async () => {
      const { host, ed, m, o } = await shown('inline');
      m.zones = [{ after: 149, height: 57 }];
      // 25 px into the zone: original line 151, 6 px down. (The original strip is aligned: its
      // lines 150-152 sit where the modified side's zone is.)
      m.scrollTop = m.getTopForLineNumber(150, true) + 25 - 250;
      ed.updateOptions.mockImplementationOnce(() => relayout(m, () => {
        m.zones = [{ after: 20, height: 38 }, { after: 149, height: 57 }]; // Split: filler for the deletion, and an alignment above
        o.zones = [{ after: 20, height: 38 }];
      }));
      host.setDiffPrefs(split);
      await flush();
      expect(centre(m)).toBe(o.getTopForLineNumber(151) + 6);
    });

    it('and back from Split: an original line lands in the inline deleted-lines zone', async () => {
      const { host, ed, m, o } = await shown('split');
      m.zones = [{ after: 149, height: 57 }];
      // In Split the centre falls in the modified side's filler: the original side has line 152.
      m.scrollTop = o.getTopForLineNumber(152) + 3 - 250;
      ed.updateOptions.mockImplementationOnce(() => relayout(m, () => {
        m.zones = [{ after: 10, height: 19 }, { after: 149, height: 57 }];
        o.zones = [{ after: 10, height: 19 }];
      }));
      host.setDiffPrefs({ ...split, mode: 'inline' });
      await flush();
      expect(centre(m)).toBe(m.getTopForLineNumber(150, true) + 2 * 19 + 3);
    });

    it('at the very top it stays at the top, at the very bottom at the bottom', async () => {
      const { host, ed, m, inside } = await shown('inline');
      m.scrollTop = 0;
      ed.updateOptions.mockImplementationOnce(() => relayout(m, () => { m.zones = [{ after: 0, height: 57 }]; }));
      host.setDiffPrefs(split);
      await flush();
      expect(m.scrollTop).toBe(0);
      user(inside);
      m.scrollTop = m.getScrollHeight() - 500;
      ed.updateOptions.mockImplementationOnce(() => relayout(m, () => { m.zones = [{ after: 0, height: 57 }, { after: 100, height: 190 }]; }));
      host.setDiffPrefs({ ...split, mode: 'inline' });
      await flush();
      expect(m.scrollTop).toBe(m.getScrollHeight() - 500);
    });

    it("Ignore whitespace: the recompute's relayout (Monaco restoring its own scroll state) is followed, then the user takes over", async () => {
      const { host, m, state, inside } = await shown('inline');
      m.scrollTop = m.getTopForLineNumber(100) - 250;
      host.setDiffPrefs({ mode: 'inline', ignoreWhitespace: true, wordWrap: false });
      expect(centre(m)).toBe(m.getTopForLineNumber(100));
      // The result lands: the view zones change between the viewport's top and its centre, inside
      // Monaco's capture/restore (which keeps the top line, so the centre would move), and then
      // onDidUpdateDiff.
      relayout(m, () => { m.zones = [{ after: 95, height: 95 }]; });
      [...state.diffs[0].listeners].forEach((l) => l());
      await flush();
      expect(centre(m)).toBe(m.getTopForLineNumber(100));
      // The user takes over: a later relayout doesn't pull the view back.
      host.setDiffPrefs({ mode: 'inline', ignoreWhitespace: false, wordWrap: false });
      user(inside);
      const mine = m.scrollTop - 400;
      m.scrollTop = mine;
      relayout(m, () => { m.zones = [{ after: 95, height: 95 }, { after: 190, height: 95 }]; });
      [...state.diffs[0].listeners].forEach((l) => l());
      await flush();
      expect(m.scrollTop).toBe(mine);
    });

    it('holds the place for as long as the recompute takes, not a fixed 2 s', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const { host, m, state } = await shown('inline');
      m.scrollTop = m.getTopForLineNumber(100) - 250;
      host.setDiffPrefs({ mode: 'inline', ignoreWhitespace: true, wordWrap: false });
      await vi.advanceTimersByTimeAsync(5000); // a slow recompute
      relayout(m, () => { m.zones = [{ after: 95, height: 95 }]; }); // between the top and the centre
      [...state.diffs[0].listeners].forEach((l) => l());
      await vi.advanceTimersByTimeAsync(0);
      expect(centre(m)).toBe(m.getTopForLineNumber(100));
      // After the result, only a short hold for late relayouts: past it, a relayout is Monaco's alone.
      await vi.advanceTimersByTimeAsync(2500);
      relayout(m, () => { m.zones = [{ after: 95, height: 190 }]; });
      await vi.advanceTimersByTimeAsync(0);
      expect(centre(m)).not.toBe(m.getTopForLineNumber(100));
      vi.useRealTimers();
    });

    it('showing a new file is not a mode switch: it opens at its own first change, and a held place never pulls it back', async () => {
      const { host, m, state } = await shown('inline');
      // Held: line 100, 3 px down (a recompute pending).
      m.scrollTop = m.getTopForLineNumber(100) + 3 - 250;
      host.setDiffPrefs({ mode: 'inline', ignoreWhitespace: true, wordWrap: false });
      expect(m.scrollTop).toBe(1634);
      // The next file's first change is line 90 (1691-1710 px), centred. Its layout has a zone
      // between 90 and 100, so restoring line 100 would scroll 57 px further.
      state.lineChanges = [{ originalStartLineNumber: 90, originalEndLineNumber: 90, modifiedStartLineNumber: 90, modifiedEndLineNumber: 90 }];
      m.zones = [{ after: 95, height: 57 }];
      await host.showDiff({ path: 'g.txt', original: lines(200), modified: lines(200), language: 'plaintext', prefs: { mode: 'inline', ignoreWhitespace: true, wordWrap: false } });
      expect(m.scrollTop).toBe(1700.5 - 250);
      await flush(); // the new model's onDidUpdateDiff
      m.sizeListeners.forEach((l) => l({}));
      await flush();
      expect(m.scrollTop).toBe(1700.5 - 250);
    });

    it('Ignore whitespace removing the anchored change: the original line maps to its modified line', async () => {
      const { host, m, state } = await shown('inline');
      m.zones = [{ after: 149, height: 57 }];
      m.scrollTop = m.getTopForLineNumber(150, true) + 25 - 250; // original line 151
      host.setDiffPrefs({ mode: 'inline', ignoreWhitespace: true, wordWrap: false });
      // The recompute finds lines 150-152 equal after all: no change, no zone; original 151 is
      // modified 151 (nothing above it shifts lines).
      state.lineChanges = [];
      (m as unknown as { model: unknown }).model = { getLineCount: () => 200 };
      relayout(m, () => { m.zones = []; });
      [...state.diffs[0].listeners].forEach((l) => l());
      await flush();
      expect(centre(m)).toBe(m.getTopForLineNumber(151) + 6);
    });

    it('Split filler after a modification with more old lines than new anchors on the original side', async () => {
      const { host, ed, m, o, state } = await shown('split');
      // Old 60-63 became new 60: Split pads the modified side after line 60 (3 lines of filler).
      state.lineChanges = [{ originalStartLineNumber: 60, originalEndLineNumber: 63, modifiedStartLineNumber: 60, modifiedEndLineNumber: 60 }];
      m.zones = [{ after: 60, height: 57 }];
      m.scrollTop = o.getTopForLineNumber(62) + 4 - 250;
      // Inline: old 60-63 above new 60; the original strip faces new 60 with a zone after old 63.
      ed.updateOptions.mockImplementationOnce(() => relayout(m, () => { m.zones = [{ after: 59, height: 76 }]; o.zones = [{ after: 63, height: 19 }]; }));
      host.setDiffPrefs({ ...split, mode: 'inline' });
      await flush();
      expect(centre(m)).toBe(m.getTopForLineNumber(60, true) + 2 * 19 + 4);
    });

    it('word wrap: unevenly wrapped deleted lines are found through the original editor, and the late relayout is followed', async () => {
      const { host, m, o, inside } = await shown('inline');
      m.zones = [{ after: 149, height: 57 }];
      m.scrollTop = m.getTopForLineNumber(150, true) + 25 - 250; // original 151, 6/19 down it
      host.setDiffPrefs({ mode: 'inline', ignoreWhitespace: false, wordWrap: true });
      // The wrap lands later (Monaco's RunOnceScheduler), through a relayout: old line 151 now
      // wraps to two visual lines (the zone grows to 76 px, and the original strip gets a 19 px
      // wrap zone after 151), and modified line 100 above wraps too (the strip aligns after 100).
      relayout(m, () => {
        m.zones = [{ after: 149, height: 76 }];
        m.heights = { 100: 38 };
        o.zones = [{ after: 100, height: 19 }, { after: 151, height: 19 }];
      });
      await flush();
      // 6/19 of line 151's extent, which is now 38 px.
      expect(centre(m)).toBe(o.getTopForLineNumber(151) + 12);
      // The next deleted line: the uneven wrap above it doesn't throw the count off.
      user(inside);
      m.scrollTop = o.getTopForLineNumber(152) + 5 - 250;
      host.setDiffPrefs({ mode: 'split', ignoreWhitespace: false, wordWrap: true });
      await flush();
      expect(centre(m)).toBe(o.getTopForLineNumber(152) + 5);
    });

    it('Hunk: Monaco maps hidden lines onto the visible line above; each spot of a collapsed view anchors right', async () => {
      // Lines 110-140 collapse behind a 24 px bar after line 109.
      const cases: [string, (m: FakeCodeEditor) => number, (m: FakeCodeEditor) => number][] = [
        // A visible line after the region, 7 px down it.
        ['after', (m) => m.getTopForLineNumber(141) + 7, (m) => m.getTopForLineNumber(141) + 7],
        // The visible line right above the region (the search lands on a hidden line mapped onto it).
        ['above', (m) => m.getTopForLineNumber(109) + 25, (m) => m.getTopForLineNumber(109) + 25],
        // The "N hidden lines" bar: the first line after the region.
        ['bar', (m) => m.getBottomForLineNumber(109) + 12, (m) => m.getTopForLineNumber(141)],
      ];
      for (const [name, at, expected] of cases) {
        const { host, ed, m } = await shown('hunk');
        m.hidden = [[110, 140]];
        m.zones = [{ after: 109, height: 24 }];
        // Line 109 wraps (38 px): its height must come from its own box, not from the (hidden)
        // line after it, which Monaco maps back onto 109.
        m.heights = { 109: 38 };
        expect(m.getTopForLineNumber(125)).toBe(m.getTopForLineNumber(109));
        m.scrollTop = at(m) - 250;
        ed.updateOptions.mockImplementationOnce(() => relayout(m, () => { m.hidden = []; m.zones = []; }));
        host.setDiffPrefs({ mode: 'inline', ignoreWhitespace: false, wordWrap: false });
        await flush();
        expect(centre(m), name).toBe(expected(m));
      }
    });

    it('Hunk + Ignore whitespace: the collapsed regions change first, Monaco recovering its viewport start, and the place is still kept', async () => {
      // Ignore whitespace on: a whitespace-only change above the viewport is collapsed with the
      // lines around it (20-70, behind a bar after 19).
      const { host, m, state } = await shown('hunk', true);
      m.hidden = [[20, 70]];
      m.zones = [{ after: 19, height: 24 }];
      m.scrollTop = m.getTopForLineNumber(100) - 250;
      const top = m.getVisibleRanges()[0].startLineNumber;
      host.setDiffPrefs({ mode: 'hunk', ignoreWhitespace: false, wordWrap: false });
      // The result: in one transaction the regions split around the change (setHiddenAreas, which
      // recovers the viewport start and emits the content-size event after the scroll), then the
      // view zones change (its deleted lines, and a zone between the top and the centre), then
      // onDidUpdateDiff.
      viewModelChange(m, () => { m.hidden = [[20, 40], [48, 70]]; m.zones = [{ after: 19, height: 24 }, { after: 47, height: 24 }]; });
      expect(m.getVisibleRanges()[0].startLineNumber).toBe(top); // Monaco kept the top line
      relayout(m, () => { m.zones = [{ after: 19, height: 24 }, { after: 43, height: 38 }, { after: 47, height: 24 }, { after: 95, height: 95 }]; });
      diffDone(state);
      await flush();
      expect(centre(m)).toBe(m.getTopForLineNumber(100));
    });

    it("word wrap: Monaco's line-break recovery moves the scroll before its content-size event, and the place is still kept", async () => {
      const { host, m } = await shown('inline');
      m.zones = [{ after: 95, height: 57 }];
      m.scrollTop = m.getTopForLineNumber(100) - 250;
      host.setDiffPrefs({ mode: 'inline', ignoreWhitespace: false, wordWrap: true });
      // The line breaks land later: line 20, above the viewport, wraps (the viewport start is
      // recovered, inside the view-model change), then the deleted lines between the top and the
      // centre wrap (their zone grows, inside Monaco's own scroll capture/restore).
      viewModelChange(m, () => { m.heights = { 20: 38 }; });
      relayout(m, () => { m.zones = [{ after: 95, height: 114 }]; });
      await flush();
      expect(centre(m)).toBe(m.getTopForLineNumber(100));
    });

    it('a second prefs change while a recompute is pending keeps waiting for it, whatever Monaco scrolled meanwhile', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const { host, m, state } = await shown('inline');
      m.scrollTop = m.getTopForLineNumber(100) - 250;
      host.setDiffPrefs({ mode: 'inline', ignoreWhitespace: true, wordWrap: false });
      // Monaco moves the view on its own (no input, no event we see), then Word wrap goes on.
      m.scrollTop += 40;
      host.setDiffPrefs({ mode: 'inline', ignoreWhitespace: true, wordWrap: true });
      await vi.advanceTimersByTimeAsync(5000); // the recompute is slow
      relayout(m, () => { m.zones = [{ after: 95, height: 95 }]; });
      diffDone(state);
      await vi.advanceTimersByTimeAsync(0);
      expect(centre(m)).toBe(m.getTopForLineNumber(100));
      vi.useRealTimers();
    });

    it('Ignore whitespace on and straight off: the place is held until the second result, not just the first', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const { host, m, state } = await shown('inline');
      m.scrollTop = m.getTopForLineNumber(100) - 250;
      host.setDiffPrefs({ mode: 'inline', ignoreWhitespace: true, wordWrap: false });
      host.setDiffPrefs({ mode: 'inline', ignoreWhitespace: false, wordWrap: false });
      relayout(m, () => { m.zones = [{ after: 95, height: 95 }]; });
      diffDone(state);
      await vi.advanceTimersByTimeAsync(3000); // the second compute takes longer than the hold
      relayout(m, () => { m.zones = [{ after: 95, height: 190 }]; });
      diffDone(state);
      await vi.advanceTimersByTimeAsync(0);
      expect(centre(m)).toBe(m.getTopForLineNumber(100));
      vi.useRealTimers();
    });

    it('the user takes over by input only: a pointer, the wheel, a key that is not a lone modifier, or Next/Previous change', async () => {
      const { host, m, inside } = await shown('inline');
      // Each relayout grows a zone between the top and the centre by one more line.
      let grown = 0;
      const relayoutAbove = () => relayout(m, () => { m.zones = [{ after: 95, height: 19 * ++grown }]; });
      const kept = async (after: () => void) => {
        m.scrollTop = m.getTopForLineNumber(100) - 250;
        toggle();
        after();
        relayoutAbove();
        await flush();
        return centre(m) === m.getTopForLineNumber(100);
      };
      let wrap = false;
      const toggle = () => host.setDiffPrefs({ mode: 'inline', ignoreWhitespace: false, wordWrap: (wrap = !wrap) });
      const key = (k: string) => () => user(inside, new KeyboardEvent('keydown', { key: k, bubbles: true }));
      expect(await kept(() => {})).toBe(true);
      for (const k of ['Shift', 'Control', 'Alt', 'Meta']) expect(await kept(key(k)), k).toBe(true);
      // A pointer that doesn't scroll (a scrollbar press, a click): the place is the user's now.
      expect(await kept(() => user(inside)), 'pointerdown').toBe(false);
      expect(await kept(() => user(inside, new Event('wheel', { bubbles: true }))), 'wheel').toBe(false);
      expect(await kept(key('PageDown')), 'PageDown').toBe(false);
      expect(await kept(() => host.goToChange('next')), 'goToChange').toBe(false);
      expect(m.setPosition).toHaveBeenLastCalledWith({ lineNumber: 150, column: 1 });
    });

    it('detaching the diff lets the place go', async () => {
      const { host, el, m } = await shown('inline');
      m.scrollTop = m.getTopForLineNumber(100) - 250;
      host.setDiffPrefs(split);
      host.detachDiff(el);
      // A relayout after that is Monaco's alone: its restore keeps the top line, so the new zone
      // between the top and the centre pushes line 100 below the centre.
      relayout(m, () => { m.zones = [{ after: 95, height: 57 }]; });
      await flush();
      expect(centre(m)).toBe(m.getTopForLineNumber(100) - 57);
    });

    it("an old line of a change with more old lines than new: its extent ends with the deleted lines, not Inline's filler for the new ones", async () => {
      // Old 60-63 became new 60. Split pads the modified side with 3 lines after new 60; Inline
      // shows old 60-63 in a zone above new 60, and pads the original strip after old 63 to face
      // new 60 (19 px).
      const change = { originalStartLineNumber: 60, originalEndLineNumber: 63, modifiedStartLineNumber: 60, modifiedEndLineNumber: 60 };
      const inline = (m: FakeCodeEditor, o: FakeCodeEditor) => { m.zones = [{ after: 59, height: 76 }]; o.zones = [{ after: 63, height: 19 }]; };
      const sideBySide = (m: FakeCodeEditor, o: FakeCodeEditor) => { m.zones = [{ after: 60, height: 57 }]; o.zones = []; };
      // Split -> Inline: 9 px into old line 63 (in Split, the modified side's filler).
      {
        const { host, ed, m, o, state } = await shown('split');
        state.lineChanges = [change];
        sideBySide(m, o);
        m.scrollTop = o.getTopForLineNumber(63) + 9 - 250;
        ed.updateOptions.mockImplementationOnce(() => relayout(m, () => inline(m, o)));
        host.setDiffPrefs({ ...split, mode: 'inline' });
        await flush();
        expect(centre(m), 'Split -> Inline').toBe(o.getTopForLineNumber(63) + 9);
      }
      // Inline -> Split: 9 px into old line 63 (in Inline, the deleted-lines zone).
      {
        const { host, ed, m, o, state } = await shown('inline');
        state.lineChanges = [change];
        inline(m, o);
        m.scrollTop = o.getTopForLineNumber(63) + 9 - 250;
        ed.updateOptions.mockImplementationOnce(() => relayout(m, () => sideBySide(m, o)));
        host.setDiffPrefs(split);
        await flush();
        expect(centre(m), 'Inline -> Split').toBe(o.getTopForLineNumber(63) + 9);
      }
    });
  });
});
