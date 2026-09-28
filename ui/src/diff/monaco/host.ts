import type * as MonacoNs from 'monaco-editor/editor/editor.api';
import { DEFAULT_DIFF_PREFS, type DiffPrefs } from '../diffPrefs';
import { useEditorSettings } from '../editorSettings';
import { diffEditorOptions, fileViewOptions } from '../options';
import { enableDeletedLineCopy } from './deletedCopy';
import { captureAnchor, restoreAnchor, type ScrollAnchor } from './scrollAnchor';
import { monaco } from './setup';
import { EDITOR_THEME, ensureLanguage, ensureTheme } from './shiki';

export interface DiffShowRequest { path: string; original: string; modified: string; language: string; prefs: DiffPrefs }
export interface FileShowRequest { path: string; text: string; language: string; wordWrap: boolean }
/** What an editor holds, to tell whether a re-attached one still shows the right content. */
export type DiffContent = Pick<DiffShowRequest, 'path' | 'original' | 'modified'>;
export type FileContent = Pick<FileShowRequest, 'path' | 'text'>;
export interface EditorContextMenuEvent {
  path: string;
  side: 'original' | 'modified' | 'file';
  line: number;
  selection: { startLine: number; endLine: number } | null;
  x: number;
  y: number;
}

export interface MonacoHost {
  /** `next`: the diff the attaching view will show. The one editor is shared, so it may still
   * hold another view's diff (the panel closed, then another commit's file opened, H6); it's
   * hidden until `showDiff` puts `next` on screen, so that one is never presented for a frame. */
  attachDiff(el: HTMLElement, next?: DiffContent): void;
  detachDiff(el: HTMLElement): void;
  /** Resolves once the diff is on screen. Monaco computes it off-screen first, so the previous
   * diff stays until the new one swaps in whole: decorations, Hunk mode's collapsed regions and,
   * in Inline and Split, scrolled to its first change. A newer call makes an older one a no-op.
   * `attachDiff` must have run first: before that there's no diff editor, and it resolves
   * without showing anything. */
  showDiff(req: DiffShowRequest): Promise<void>;
  /** The user's mode and toggles, applied to the shown diff. The line at the viewport centre
   * stays there (the top or bottom, when scrolled to one), including after a recompute
   * (Ignore whitespace), until the user takes over (a pointer, the wheel, a key, Next/Previous
   * change) or another file shows. No jump to the first change: that's for a new file only. */
  setDiffPrefs(prefs: DiffPrefs): void;
  goToChange(direction: 'next' | 'previous'): void;
  /** `next`: as `attachDiff`'s, for File View. */
  attachFile(el: HTMLElement, next?: FileContent): void;
  detachFile(el: HTMLElement): void;
  /** `attachFile` must have run first: before that there's no file editor, and it resolves
   * without showing anything. */
  showFile(req: FileShowRequest): Promise<void>;
  /** File View's word wrap, applied in place: the model (and so the scroll position) is kept. */
  setFileWordWrap(on: boolean): void;
  /** Puts the keyboard in the attached editor: the diff's modified side, else the file editor.
   * A no-op while neither is attached. */
  focus(): void;
  /** Plan 1C seam: its context menu replaces Monaco's. `null` restores Monaco's own menu, which
   * stays on in 1B (plan 1B deviation 1). */
  setContextMenuHandler(handler: ((e: EditorContextMenuEvent) => void) | null): void;
  layout(): void;
}

type Side = EditorContextMenuEvent['side'];

/** Lines of context above the first change when a diff opens scrolled to it (as Hunk mode's). */
export const REVEAL_CONTEXT_LINES = 3;
/** How long a diff may take to compute before it's shown anyway (without its decorations). */
const DIFF_BACKSTOP_MS = 5000;
/** How long a prefs change keeps its anchor for relayouts that land later (word wrap's line
 * breaks), counted from the change or, when it recomputes the diff (Ignore whitespace), from the
 * recompute's result. */
const ANCHOR_HOLD_MS = 2000;
/** The longest a recompute is waited for before the place is let go anyway. */
const ANCHOR_RECOMPUTE_MAX_MS = 15_000;
/** Monaco's `ScrollType.Immediate`: no smooth scrolling. */
const SCROLL_IMMEDIATE = 1;
/** Keys that are only modifiers: pressing one alone isn't the user taking over the scroll. */
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'AltGraph', 'Meta', 'OS', 'Super', 'Hyper', 'Fn', 'FnLock', 'CapsLock', 'NumLock', 'ScrollLock', 'Symbol', 'SymbolLock']);

/** Resolves when `p` does, or after `ms`, whichever is first, leaving no timer behind. */
function withBackstop(p: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<void>((r) => { timer = setTimeout(r, ms); })]).finally(() => clearTimeout(timer));
}

const sticky = () => useEditorSettings.getState().settings.stickyScroll;

const sameDiff = (a: DiffContent, b: DiffContent) => a.path === b.path && a.original === b.original && a.modified === b.modified;

/** Hides `el` while the editor in it holds content (`shown`) other than what the attaching view
 * will show (`next`). Visible again once that is shown. */
function hideUnless<T>(el: HTMLElement, shown: T | null, next: T | undefined, same: (a: T, b: T) => boolean): void {
  el.style.visibility = shown && next && !same(shown, next) ? 'hidden' : '';
}

/** One diff editor and one file editor for the whole app (spec §4.4), re-parented into whichever
 * container attaches. */
class Host implements MonacoHost {
  private readonly diffEl = document.createElement('div');
  private readonly fileEl = document.createElement('div');
  private diff: MonacoNs.editor.IStandaloneDiffEditor | null = null;
  private file: MonacoNs.editor.IStandaloneCodeEditor | null = null;
  private diffModels: MonacoNs.editor.ITextModel[] = [];
  private diffView: MonacoNs.editor.IDiffEditorViewModel | null = null;
  /** The place a prefs change keeps while its relayouts may still land (a recompute, word wrap's
   * line breaks), until the user takes over by input. Scroll positions can't tell: Monaco moves
   * the view itself while it relayouts (recovering its viewport start, restoring its scroll
   * state), and reports that before or after the relayout's own events, depending on the path. */
  private anchor: ScrollAnchor | null = null;
  private anchorTimer: ReturnType<typeof setTimeout> | undefined;
  /** Recomputes (Ignore whitespace) that prefs changes asked for and whose results aren't in: the
   * place is held until the last one is. Monaco computes each to the end (a later one doesn't
   * cancel an earlier one), and each result fires onDidUpdateDiff. */
  private pendingDiffs = 0;
  /** A re-anchor is queued for after the current relayout (see `onRelayout`). */
  private reanchorQueued = false;
  /** Our own re-anchor is scrolling: its scroll events aren't a relayout to follow. */
  private restoring = false;
  private fileModel: MonacoNs.editor.ITextModel | null = null;
  /** What each editor has on screen (null: nothing yet). */
  private diffShown: DiffContent | null = null;
  private fileShown: FileContent | null = null;
  // The latest diff prefs and File View wrap, whoever set them last: a show call adopts its own
  // at call time, and a later set* call during its grammar load still wins.
  private prefs: DiffPrefs = DEFAULT_DIFF_PREFS;
  private fileWrap = DEFAULT_DIFF_PREFS.wordWrap;
  private computedCount = 0;
  private menu: ((e: EditorContextMenuEvent) => void) | null = null;
  private diffPath = '';
  private filePath = '';
  private diffSeq = 0;
  private fileSeq = 0;
  private readonly ro = new ResizeObserver(() => this.layout());

  constructor() {
    this.diffEl.className = 'monaco-host';
    this.fileEl.className = 'monaco-host';
    // The sticky-scroll setting (H7; plan 1C's settings screen changes it) applies in place.
    useEditorSettings.subscribe((s, prev) => {
      if (s.settings.stickyScroll === prev.settings.stickyScroll) return;
      const stickyScroll = { enabled: s.settings.stickyScroll };
      this.diff?.updateOptions({ stickyScroll });
      this.file?.updateOptions({ stickyScroll });
    });
  }

  attachDiff(el: HTMLElement, next?: DiffContent): void {
    hideUnless(this.diffEl, this.diffShown, next, sameDiff);
    el.appendChild(this.diffEl);
    this.ro.observe(el);
    if (!this.diff) {
      this.diff = monaco.editor.createDiffEditor(this.diffEl, { ...diffEditorOptions(this.prefs, this.menu === null, sticky()), theme: EDITOR_THEME });
      // A plain DOM signal that a diff (or a prefs recompute) is done, for e2e waits.
      this.diff.onDidUpdateDiff(() => {
        this.diffEl.dataset.diffComputed = String(++this.computedCount);
        // A recompute (Ignore whitespace) relayouts again once done: keep the anchored place, and
        // once the last one is in, the hold only waits for late relayouts (word wrap).
        if (this.anchor && this.pendingDiffs > 0 && --this.pendingDiffs === 0) this.holdFor(ANCHOR_HOLD_MS);
        this.onRelayout();
      });
      this.wireMenu(this.diff.getOriginalEditor(), 'original');
      this.wireMenu(this.diff.getModifiedEditor(), 'modified');
      enableDeletedLineCopy(this.diff);
      // A relayout that lands later still (word wrap's line breaks, a recompute's view zones and
      // collapsed regions), or Monaco moving the view itself (recovering its viewport start):
      // keep the anchored place.
      const m = this.diff.getModifiedEditor();
      m.onDidContentSizeChange(() => this.onRelayout());
      m.onDidScrollChange((e) => {
        if (e.scrollTopChanged && !this.restoring) this.onRelayout();
      });
      // The user takes over by input anywhere in the diff editor: a pointer (scrollbar drags, the
      // minimap, a click), the wheel, a key other than a lone modifier. Capture phase, before
      // Monaco handles (and maybe stops) it. Next/Previous change: see `goToChange`.
      const drop = () => this.dropAnchor();
      this.diffEl.addEventListener('pointerdown', drop, { capture: true });
      this.diffEl.addEventListener('wheel', drop, { capture: true, passive: true });
      this.diffEl.addEventListener('keydown', (e) => {
        if (!MODIFIER_KEYS.has(e.key)) this.dropAnchor();
      }, { capture: true });
    }
    this.layout();
  }

  detachDiff(el: HTMLElement): void {
    this.dropAnchor();
    this.ro.unobserve(el);
    if (this.diffEl.parentElement === el) el.removeChild(this.diffEl);
  }

  /** A failed show un-hides the editor: the view's error UI (and its Retry) takes over. */
  async showDiff(req: DiffShowRequest): Promise<void> {
    try {
      await this.presentDiff(req);
    } catch (e) {
      this.diffEl.style.visibility = '';
      throw e;
    }
  }

  private async presentDiff(req: DiffShowRequest): Promise<void> {
    const seq = ++this.diffSeq;
    this.prefs = req.prefs;
    const lang = await ensureLanguage(monaco, req.language);
    const ed = this.diff;
    if (seq !== this.diffSeq || !ed) return;
    this.dropAnchor();
    this.applyDiffPrefs(this.prefs);
    const original = monaco.editor.createModel(req.original, lang);
    const modified = monaco.editor.createModel(req.modified, lang);
    // Off-screen: a view model computes its diff before it's attached, so the previous diff stays
    // on screen meanwhile, and the new one appears whole in one frame (F24, F27). Attaching an
    // uncomputed pair would draw the plain file first: no decorations, and in Hunk mode the whole
    // file for a frame before its regions collapse.
    const view = ed.createViewModel({ original, modified });
    await withBackstop(view.waitForDiff(), DIFF_BACKSTOP_MS);
    if (seq !== this.diffSeq) {
      view.dispose();
      original.dispose();
      modified.dispose();
      return;
    }
    this.diffPath = req.path;
    // A new presentation: whatever place a prefs change was keeping is gone.
    this.dropAnchor();
    ed.setModel(view);
    // Before the next frame renders: the diff shows up already at its first change.
    this.revealFirstChange(ed);
    // A new model gets a new view, which Monaco would paint empty and fill a frame later (the
    // "black frame"): draw both sides now, in this task.
    ed.getOriginalEditor().render(true);
    ed.getModifiedEditor().render(true);
    this.diffShown = { path: req.path, original: req.original, modified: req.modified };
    this.diffEl.style.visibility = '';
    this.diffView?.dispose();
    for (const m of this.diffModels) m.dispose();
    this.diffView = view;
    this.diffModels = [original, modified];
  }

  /** Inline and Split: scrolls the new diff so its first change sits near the top, with
   * `REVEAL_CONTEXT_LINES` above it (F28), unless it's already on the first screen. Once per `showDiff`, never on a prefs change, so it
   * doesn't fight the user's own scrolling. Hunk mode already starts at its first hunk. */
  private revealFirstChange(ed: MonacoNs.editor.IStandaloneDiffEditor): void {
    if (this.prefs.mode === 'hunk') return;
    const first = ed.getLineChanges()?.[0];
    if (!first) return;
    // A pure deletion reports the line above it; its removed lines show below that line.
    const line = first.modifiedEndLineNumber === 0 ? first.modifiedStartLineNumber + 1 : first.modifiedStartLineNumber;
    const m = ed.getModifiedEditor();
    // Already on the first screen: leave it at the top.
    if (m.getTopForLineNumber(line + 1) <= m.getLayoutInfo().height) return;
    m.setScrollTop(m.getTopForLineNumber(Math.max(1, line - REVEAL_CONTEXT_LINES)), SCROLL_IMMEDIATE);
  }

  setDiffPrefs(prefs: DiffPrefs): void {
    const ed = this.diff;
    const recomputes = prefs.ignoreWhitespace !== this.prefs.ignoreWhitespace;
    // An anchor still held (a relayout or recompute not in yet) is the truer place than the
    // scroll now, whatever Monaco scrolled meanwhile.
    const anchor = ed && this.diffModels.length ? (this.anchor ?? captureAnchor(ed, this.prefs.mode)) : null;
    this.applyDiffPrefs(prefs);
    if (!ed || !anchor) return;
    this.anchor = anchor;
    this.restore(ed, anchor);
    if (recomputes) this.pendingDiffs++;
    this.holdFor(this.pendingDiffs > 0 ? ANCHOR_RECOMPUTE_MAX_MS : ANCHOR_HOLD_MS);
  }

  /** Scrolls back to `at`. */
  private restore(ed: MonacoNs.editor.IStandaloneDiffEditor, at: ScrollAnchor): void {
    this.restoring = true;
    try {
      restoreAnchor(ed, at);
    } finally {
      this.restoring = false;
    }
  }

  private holdFor(ms: number): void {
    clearTimeout(this.anchorTimer);
    this.anchorTimer = setTimeout(() => this.dropAnchor(), ms);
  }

  /**
   * A relayout, or Monaco moving the view, while a place is held: re-anchor once it's over.
   * Monaco relayouts view zones inside a StableEditorScrollState capture/restore
   * (DiffEditorWidget's applyViewZones) and fires onDidContentSizeChange from inside it, so a
   * scroll right away would be undone by that restore. Hidden areas (Hunk) and line breaks (word
   * wrap) recover the viewport start inside a view-event collector, and their events come after
   * that scroll. So the re-anchor runs in a microtask, after Monaco's own restore, whatever the
   * order. Only input lets the place go (see `attachDiff`).
   */
  private onRelayout(): void {
    if (!this.anchor || this.reanchorQueued) return;
    this.reanchorQueued = true;
    queueMicrotask(() => {
      this.reanchorQueued = false;
      if (this.anchor && this.diff) this.restore(this.diff, this.anchor);
    });
  }

  private applyDiffPrefs(prefs: DiffPrefs): void {
    this.prefs = prefs;
    this.diff?.updateOptions(diffEditorOptions(prefs, this.menu === null, sticky()));
  }

  private dropAnchor(): void {
    this.anchor = null;
    this.pendingDiffs = 0;
    clearTimeout(this.anchorTimer);
  }

  goToChange(direction: 'next' | 'previous'): void {
    // The user's own move (F7, Next/Previous change): a kept place mustn't pull the view back.
    this.dropAnchor();
    this.diff?.goToDiff(direction);
  }

  attachFile(el: HTMLElement, next?: FileContent): void {
    hideUnless(this.fileEl, this.fileShown, next, (a, b) => a.path === b.path && a.text === b.text);
    el.appendChild(this.fileEl);
    this.ro.observe(el);
    if (!this.file) {
      this.file = monaco.editor.create(this.fileEl, { ...fileViewOptions(this.fileWrap, this.menu === null, sticky()), theme: EDITOR_THEME });
      this.wireMenu(this.file, 'file');
    }
    this.layout();
  }

  detachFile(el: HTMLElement): void {
    this.ro.unobserve(el);
    if (this.fileEl.parentElement === el) el.removeChild(this.fileEl);
  }

  async showFile(req: FileShowRequest): Promise<void> {
    try {
      await this.presentFile(req);
    } catch (e) {
      this.fileEl.style.visibility = '';
      throw e;
    }
  }

  private async presentFile(req: FileShowRequest): Promise<void> {
    const seq = ++this.fileSeq;
    this.fileWrap = req.wordWrap;
    const lang = await ensureLanguage(monaco, req.language);
    const ed = this.file;
    if (seq !== this.fileSeq || !ed) return;
    this.filePath = req.path;
    ed.updateOptions(fileViewOptions(this.fileWrap, this.menu === null, sticky()));
    const model = monaco.editor.createModel(req.text, lang);
    ed.setModel(model);
    this.fileShown = { path: req.path, text: req.text };
    this.fileEl.style.visibility = '';
    this.fileModel?.dispose();
    this.fileModel = model;
  }

  setFileWordWrap(on: boolean): void {
    this.fileWrap = on;
    this.file?.updateOptions({ wordWrap: on ? 'on' : 'off' });
  }

  focus(): void {
    if (this.diff && this.diffEl.parentElement) this.diff.getModifiedEditor().focus();
    else if (this.file && this.fileEl.parentElement) this.file.focus();
  }

  setContextMenuHandler(handler: ((e: EditorContextMenuEvent) => void) | null): void {
    this.menu = handler;
    this.diff?.updateOptions({ contextmenu: handler === null });
    this.file?.updateOptions({ contextmenu: handler === null });
  }

  layout(): void {
    const size = (el: HTMLElement) => ({ width: el.parentElement?.clientWidth ?? 0, height: el.parentElement?.clientHeight ?? 0 });
    if (this.diff && this.diffEl.parentElement) this.diff.layout(size(this.diffEl));
    if (this.file && this.fileEl.parentElement) this.file.layout(size(this.fileEl));
  }

  private wireMenu(ed: MonacoNs.editor.ICodeEditor, side: Side): void {
    ed.onContextMenu((e) => {
      if (!this.menu) return;
      // With `contextmenu: false` Monaco no longer suppresses the webview's native menu.
      e.event.preventDefault();
      const sel = ed.getSelection();
      this.menu({
        path: side === 'file' ? this.filePath : this.diffPath,
        side,
        line: e.target.position?.lineNumber ?? sel?.startLineNumber ?? 1,
        selection: sel && !sel.isEmpty() ? { startLine: sel.startLineNumber, endLine: sel.endLineNumber } : null,
        x: e.event.posx,
        y: e.event.posy,
      });
    });
  }
}

let host: Host | undefined;

/** The app's one host. The editor theme is defined before it's handed out, so the first editor
 * is created in it (see `ensureTheme`). Reached only through `loadMonacoHost`. */
export async function createHost(): Promise<MonacoHost> {
  await ensureTheme(monaco);
  return (host ??= new Host());
}
