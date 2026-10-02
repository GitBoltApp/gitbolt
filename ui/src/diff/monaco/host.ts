import type * as MonacoNs from 'monaco-editor/editor/editor.api';
import { DEFAULT_DIFF_PREFS, type DiffPrefs } from '../diffPrefs';
import { useEditorSettings } from '../editorSettings';
import { clampEditorFont, diffEditorOptions, fileViewOptions } from '../options';
import { enableDeletedLineCopy } from './deletedCopy';
import { captureAnchor, restoreAnchor, type ScrollAnchor } from './scrollAnchor';
import { monaco } from './setup';
import { useAppState } from '../../app/state';
import { bindEditorTheme, currentEditorTheme } from '../../theme/editorThemes';
import { ensureLanguage, ensureTheme } from './shiki';

export interface DiffShowRequest { /** The target's key (repo/worktree and path): what `modifiedText` checks. */ identity?: string; path: string; original: string; modified: string; language: string; prefs: DiffPrefs }
export interface FileShowRequest { identity?: string; path: string; text: string; language: string; wordWrap: boolean }
/** What an editor holds, to tell whether a re-attached one still shows the right content. */
export type DiffContent = Pick<DiffShowRequest, 'path' | 'original' | 'modified'>;
export type FileContent = Pick<FileShowRequest, 'path' | 'text'>;
export interface EditorContextMenuEvent {
  path: string;
  side: 'original' | 'modified' | 'file';
  line: number;
  selection: { startLine: number; endLine: number } | null;
  /** The selected text, `''` when `selection` is null (plan 1C Task 15's Monaco `Copy` row). */
  selectionText: string;
  x: number;
  y: number;
}

export interface MonacoHost {
  /** `next`: the diff the attaching view will show. The one editor is shared, so it may still
   * hold another view's diff (the panel closed, then another commit's file opened, H6); it's
   * hidden until `showDiff` puts `next` on screen, so that one is never presented for a frame. */
  attachDiff(el: HTMLElement, next?: DiffContent): void;
  detachDiff(el: HTMLElement): void;
  /** A kept (hidden, then shown again) panel's view (J16): true when the diff editor is still in
   * `el`, so it needn't attach again. It hides a diff other than `next` until `showDiff` puts
   * `next` on screen, as `attachDiff` does. False (nothing done) when it's elsewhere. */
  keepDiff(el: HTMLElement, next: DiffContent): boolean;
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
  /** As `keepDiff`, for File View. */
  keepFile(el: HTMLElement, next: FileContent): boolean;
  /** `attachFile` must have run first: before that there's no file editor, and it resolves
   * without showing anything. */
  showFile(req: FileShowRequest): Promise<void>;
  /** File View's word wrap, applied in place: the model (and so the scroll position) is kept. */
  setFileWordWrap(on: boolean): void;
  /** Puts the keyboard in the attached editor: the diff's modified side, else the file editor.
   * A no-op while neither is attached. */
  focus(): void;
  /** Opens Monaco's find widget (Ctrl+F while a file is open, plan 1C ruling R7) in the attached
   * editor: the diff's side holding the keyboard (else its modified side), else the file editor.
   * A no-op while neither is attached. */
  openFind(): void;
  /** Plan 1C seam: its context menu replaces Monaco's. `null` restores Monaco's own menu, which
   * stays on in 1B (plan 1B deviation 1). */
  setContextMenuHandler(handler: ((e: EditorContextMenuEvent) => void) | null): void;
  /** Lays the attached editors out in their boxes, except a hidden (0×0) one: a kept panel
   * closed with `display: none` (J16) keeps its layout for when it shows again. */
  layout(): void;
  /** Detaches an editor whose box has left the document without a detach: a kept panel
   * (J16) unmounted while hidden, whose attach cleanup already ran (and kept the editor) when it
   * was hidden. The view calls it on unmount (`releaseDetachedEditors`); the next attach elsewhere
   * lets such a box go too. */
  releaseDetached(): void;
  /** The diff's modified side is the working-tree file (spec #2 §7.5): editable. Its host element
   * gets `data-editable="true"` (key routing: an editable Monaco keeps its own Ctrl+Z). */
  setModifiedEditable(on: boolean): void;
  /** The modified side's text as edited, or `null` with no diff shown. */
  modifiedText(identity?: string): string | null;
  /** Called on each user edit of the modified side (never for a `showDiff`); `null` removes it. */
  onModifiedEdit(cb: (() => void) | null): void;
  setFileEditable(on: boolean): void;
  fileText(identity?: string): string | null;
  onFileEdit(cb: (() => void) | null): void;
  /** The next `showDiff`/`showFile` of the same path restores today's cursor and scroll (a save's reload). */
  keepViewOnNextShow(): void;
  /** Spec #2 §7.3: a view zone above each hunk's first line, in every mode. Returns the zones'
   * DOM nodes (the modified editor's), which React portals the buttons into. In Split mode the
   * original editor gets a spacer of the same height at `oldAfter`, so the sides stay aligned.
   * `[]` clears them; a new `showDiff` clears them too. */
  setHunkZones(zones: { newAfter: number; oldAfter: number }[]): HTMLElement[];
  /** Each selection in either editor (and again when it scrolls), as the lines it covers on that
   * side and where its last line is on screen; `null` when it's empty. `null` removes the listener. */
  onDiffSelection(cb: ((s: DiffSelection | null) => void) | null): void;
}

type Side = EditorContextMenuEvent['side'];

/** A non-empty selection in the diff (spec #2 §7.3): the 1-based lines it covers on `side`, and
 * where its last line is on screen. */
export interface DiffSelection { side: 'original' | 'modified'; start: number; end: number; rect: { top: number; left: number; bottom: number } }
/** The height of a hunk's header zone. */
export const HUNK_ZONE_PX = 24;

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
/** How long a save's kept cursor and scroll wait for the reload's show. */
const KEPT_VIEW_MS = 5000;
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
const fontSize = () => useAppState.getState().settings.editorFontSize;

const sameDiff = (a: DiffContent, b: DiffContent) => a.path === b.path && a.original === b.original && a.modified === b.modified;
const sameFile = (a: FileContent, b: FileContent) => a.path === b.path && a.text === b.text;

/** Hides (or shows) an editor's element. `opacity` does the hiding (K7): Monaco's diff editor
 * sets `visibility: visible` on its two inner editors, which wins over a `visibility: hidden`
 * inherited from here, so that alone left the held diff painted. `visibility` stays too: it keeps
 * the element itself out of hit-testing and the accessibility tree.
 *
 * Hidden, it's inert as well (`inert`, and `pointer-events: none` for good measure): the inner
 * editors' forced `visibility: visible` would otherwise keep them clickable and focusable. Focus
 * inside it goes to the focus zone around it (the diff panel) first, rather than to `<body>`. */
function setHidden(el: HTMLElement, hidden: boolean): void {
  if (hidden && el.contains(document.activeElement)) {
    const zone = el.parentElement?.closest<HTMLElement>('[data-focus-zone]');
    if (zone) zone.focus({ preventScroll: true });
    else (document.activeElement as HTMLElement | null)?.blur();
  }
  el.style.visibility = hidden ? 'hidden' : '';
  el.style.opacity = hidden ? '0' : '';
  el.style.pointerEvents = hidden ? 'none' : '';
  el.toggleAttribute('inert', hidden);
}

/** Hides `el` while the editor in it holds content (`shown`) other than what the attaching view
 * will show (`next`). Visible again once that is shown. */
function hideUnless<T>(el: HTMLElement, shown: T | null, next: T | undefined, same: (a: T, b: T) => boolean): void {
  setHidden(el, !!shown && !!next && !same(shown, next));
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
  private diffIdentity: string | undefined;
  private fileIdentity: string | undefined;
  private filePath = '';
  private diffSeq = 0;
  private fileSeq = 0;
  private readonly ro = new ResizeObserver(() => this.layout());
  /** The boxes the editors were last attached to (and are observed in), until detached. */
  private diffBox: HTMLElement | null = null;
  private fileBox: HTMLElement | null = null;
  private keptTimer: ReturnType<typeof setTimeout> | undefined;
  private modEdit: { dispose(): void } | null = null;
  private zones: { editor: MonacoNs.editor.ICodeEditor; id: string }[] = [];
  private selSubs: { dispose(): void }[] = [];
  private fileEditSub: { dispose(): void } | null = null;
  private keptView: { diffPath: string; diff: MonacoNs.editor.IDiffEditorViewState | null; filePath: string; file: MonacoNs.editor.ICodeEditorViewState | null } | null = null;

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
    // The editor font size (Settings > Editor) applies in place too.
    useAppState.subscribe((s, prev) => {
      if (s.settings.editorFontSize === prev.settings.editorFontSize) return;
      const fontSize = clampEditorFont(s.settings.editorFontSize);
      this.diff?.updateOptions({ fontSize });
      this.file?.updateOptions({ fontSize });
    });
  }

  attachDiff(el: HTMLElement, next?: DiffContent): void {
    hideUnless(this.diffEl, this.diffShown, next, sameDiff);
    // A previous box never detached (a kept panel unmounted while hidden, J16): stop observing it.
    if (this.diffBox && this.diffBox !== el) this.ro.unobserve(this.diffBox);
    this.diffBox = el;
    el.appendChild(this.diffEl);
    this.ro.observe(el);
    if (!this.diff) {
      this.diff = monaco.editor.createDiffEditor(this.diffEl, { ...diffEditorOptions(this.prefs, this.menu === null, sticky(), fontSize()), theme: currentEditorTheme() });
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

  keepDiff(el: HTMLElement, next: DiffContent): boolean {
    if (!this.diff || this.diffEl.parentElement !== el) return false;
    hideUnless(this.diffEl, this.diffShown, next, sameDiff);
    return true;
  }

  detachDiff(el: HTMLElement): void {
    this.dropAnchor();
    this.ro.unobserve(el);
    if (this.diffBox === el) this.diffBox = null;
    if (this.diffEl.parentElement === el) el.removeChild(this.diffEl);
  }

  /** A failed show un-hides the editor: the view's error UI (and its Retry) takes over. */
  async showDiff(req: DiffShowRequest): Promise<void> {
    try {
      await this.presentDiff(req);
    } catch (e) {
      setHidden(this.diffEl, false);
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
    this.setModifiedEditable(false);
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
    this.diffIdentity = req.identity;
    // A new presentation: whatever place a prefs change was keeping is gone.
    this.dropAnchor();
    this.setHunkZones([]);
    ed.setModel(view);
    // Before the next frame renders: the diff shows up already at its first change.
    this.revealFirstChange(ed);
    // A new model gets a new view, which Monaco would paint empty and fill a frame later (the
    // "black frame"): draw both sides now, in this task.
    ed.getOriginalEditor().render(true);
    ed.getModifiedEditor().render(true);
    this.diffShown = { path: req.path, original: req.original, modified: req.modified };
    setHidden(this.diffEl, false);
    this.diffView?.dispose();
    for (const m of this.diffModels) m.dispose();
    this.diffView = view;
    this.diffModels = [original, modified];
    if (this.keptView?.diff && this.keptView.diffPath === req.path) ed.restoreViewState(this.keptView.diff);
    this.keptView = null;
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
    this.diff?.updateOptions(diffEditorOptions(prefs, this.menu === null, sticky(), fontSize()));
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
    hideUnless(this.fileEl, this.fileShown, next, sameFile);
    if (this.fileBox && this.fileBox !== el) this.ro.unobserve(this.fileBox);
    this.fileBox = el;
    el.appendChild(this.fileEl);
    this.ro.observe(el);
    if (!this.file) {
      this.file = monaco.editor.create(this.fileEl, { ...fileViewOptions(this.fileWrap, this.menu === null, sticky(), fontSize()), theme: currentEditorTheme() });
      this.wireMenu(this.file, 'file');
    }
    this.layout();
  }

  keepFile(el: HTMLElement, next: FileContent): boolean {
    if (!this.file || this.fileEl.parentElement !== el) return false;
    hideUnless(this.fileEl, this.fileShown, next, sameFile);
    return true;
  }

  detachFile(el: HTMLElement): void {
    this.ro.unobserve(el);
    if (this.fileBox === el) this.fileBox = null;
    if (this.fileEl.parentElement === el) el.removeChild(this.fileEl);
  }

  releaseDetached(): void {
    if (this.diffBox && !this.diffBox.isConnected) this.detachDiff(this.diffBox);
    if (this.fileBox && !this.fileBox.isConnected) this.detachFile(this.fileBox);
  }

  async showFile(req: FileShowRequest): Promise<void> {
    try {
      await this.presentFile(req);
    } catch (e) {
      setHidden(this.fileEl, false);
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
    this.fileIdentity = req.identity;
    this.setFileEditable(false);
    ed.updateOptions(fileViewOptions(this.fileWrap, this.menu === null, sticky(), fontSize()));
    const model = monaco.editor.createModel(req.text, lang);
    ed.setModel(model);
    this.fileShown = { path: req.path, text: req.text };
    setHidden(this.fileEl, false);
    this.fileModel?.dispose();
    this.fileModel = model;
    if (this.keptView?.file && this.keptView.filePath === req.path) ed.restoreViewState(this.keptView.file);
    this.keptView = null;
  }

  setModifiedEditable(on: boolean): void {
    this.diff?.updateOptions({ readOnly: !on });
    this.diff?.getModifiedEditor().updateOptions({ readOnly: !on });
    this.diffEl.dataset.editable = String(on);
  }

  modifiedText(identity?: string): string | null {
    if (identity !== undefined && identity !== this.diffIdentity) return null;
    return this.diff && this.diffEl.parentElement && this.diffModels.length ? this.diff.getModifiedEditor().getValue() : null;
  }

  setHunkZones(zones: { newAfter: number; oldAfter: number }[]): HTMLElement[] {
    const ed = this.diff;
    if (!ed || (zones.length === 0 && this.zones.length === 0)) return [];
    for (const e of [ed.getModifiedEditor(), ed.getOriginalEditor()]) {
      e.changeViewZones((acc) => { for (const z of this.zones) if (z.editor === e) acc.removeZone(z.id); });
    }
    this.zones = [];
    if (zones.length === 0) return [];
    const mod = ed.getModifiedEditor();
    const nodes: HTMLElement[] = [];
    mod.changeViewZones((acc) => {
      for (const z of zones) {
        const domNode = document.createElement('div');
        domNode.className = 'hunk-zone';
        nodes.push(domNode);
        this.zones.push({ editor: mod, id: acc.addZone({ afterLineNumber: z.newAfter, heightInPx: HUNK_ZONE_PX, domNode }) });
      }
    });
    if (this.prefs.mode === 'split') {
      const orig = ed.getOriginalEditor();
      orig.changeViewZones((acc) => {
        for (const z of zones) this.zones.push({ editor: orig, id: acc.addZone({ afterLineNumber: z.oldAfter, heightInPx: HUNK_ZONE_PX, domNode: document.createElement('div') }) });
      });
    }
    return nodes;
  }

  onDiffSelection(cb: ((s: DiffSelection | null) => void) | null): void {
    for (const d of this.selSubs) d.dispose();
    this.selSubs = [];
    const ed = this.diff;
    if (!cb || !ed) return;
    for (const [side, e] of [['original', ed.getOriginalEditor()], ['modified', ed.getModifiedEditor()]] as const) {
      const report = () => {
        const s = e.getSelection();
        if (!s || s.isEmpty()) return cb(null);
        // A selection ending at column 1 of the next line covers the line above only.
        const end = s.endColumn === 1 && s.endLineNumber > s.startLineNumber ? s.endLineNumber - 1 : s.endLineNumber;
        const at = e.getScrolledVisiblePosition({ lineNumber: end, column: 1 });
        const box = e.getDomNode()?.getBoundingClientRect();
        const top = (box?.top ?? 0) + (at?.top ?? 0);
        // Scrolled out of the editor's box: no bar floating over other panels. Scrolling back reports again.
        if (box && (top < box.top || top > box.bottom - 4)) return cb(null);
        cb({ side, start: s.startLineNumber, end, rect: { top, left: (box?.left ?? 0) + (at?.left ?? 0), bottom: top + (at?.height ?? 18) } });
      };
      this.selSubs.push(e.onDidChangeCursorSelection((ev) => { if (ev.selection.isEmpty()) cb(null); else report(); }));
      let frame = 0;
      this.selSubs.push(e.onDidScrollChange(() => {
        if (frame) return;
        frame = requestAnimationFrame(() => { frame = 0; if (e.getSelection()?.isEmpty() === false) report(); });
      }));
      this.selSubs.push({ dispose: () => { if (frame) cancelAnimationFrame(frame); frame = 0; } });
    }
  }

  onModifiedEdit(cb: (() => void) | null): void {
    this.modEdit?.dispose();
    this.modEdit = cb && this.diff ? this.diff.getModifiedEditor().onDidChangeModelContent((e) => { if (!e.isFlush) cb(); }) : null;
  }

  setFileEditable(on: boolean): void {
    this.file?.updateOptions({ readOnly: !on });
    this.fileEl.dataset.editable = String(on);
  }

  fileText(identity?: string): string | null {
    if (identity !== undefined && identity !== this.fileIdentity) return null;
    return this.file && this.fileEl.parentElement && this.fileModel ? this.file.getValue() : null;
  }

  onFileEdit(cb: (() => void) | null): void {
    this.fileEditSub?.dispose();
    this.fileEditSub = cb && this.file ? this.file.onDidChangeModelContent((e) => { if (!e.isFlush) cb(); }) : null;
  }

  keepViewOnNextShow(): void {
    this.keptView = { diffPath: this.diffPath, diff: this.diff?.saveViewState() ?? null, filePath: this.filePath, file: this.file?.saveViewState() ?? null };
    // A save that changed nothing shows nothing again: the kept place isn't held for a later show.
    clearTimeout(this.keptTimer);
    this.keptTimer = setTimeout(() => { this.keptView = null; }, KEPT_VIEW_MS);
  }

  setFileWordWrap(on: boolean): void {
    this.fileWrap = on;
    this.file?.updateOptions({ wordWrap: on ? 'on' : 'off' });
  }

  focus(): void {
    if (this.diff && this.diffEl.parentElement) this.diff.getModifiedEditor().focus();
    else if (this.file && this.fileEl.parentElement) this.file.focus();
  }

  openFind(): void {
    let ed: MonacoNs.editor.ICodeEditor | null = null;
    if (this.diff && this.diffEl.parentElement) {
      const original = this.diff.getOriginalEditor();
      ed = original.hasTextFocus() ? original : this.diff.getModifiedEditor();
    } else if (this.file && this.fileEl.parentElement) ed = this.file;
    if (!ed) return;
    ed.focus();
    void ed.getAction('actions.find')?.run();
  }

  setContextMenuHandler(handler: ((e: EditorContextMenuEvent) => void) | null): void {
    this.menu = handler;
    this.diff?.updateOptions({ contextmenu: handler === null });
    this.file?.updateOptions({ contextmenu: handler === null });
  }

  layout(): void {
    const size = (el: HTMLElement) => ({ width: el.parentElement?.clientWidth ?? 0, height: el.parentElement?.clientHeight ?? 0 });
    const shown = (d: { width: number; height: number }) => d.width > 0 && d.height > 0;
    const diff = size(this.diffEl);
    const file = size(this.fileEl);
    if (this.diff && this.diffEl.parentElement && shown(diff)) this.diff.layout(diff);
    if (this.file && this.fileEl.parentElement && shown(file)) this.file.layout(file);
  }

  /** Builds and shows the menu for `ed`/`side` at `(x, y)`, from the current selection (or the
   * cursor, keyboard-triggered). Shared by the mouse and keyboard paths. A no-op while no
   * handler is set (fix round 1, item 1): with `contextmenu: false` (`setContextMenuHandler`),
   * Monaco's own `editor.action.showContextMenu` is inert too (it checks the same option), so
   * there is nothing to fall back to either way. */
  private openMenuAt(ed: MonacoNs.editor.IStandaloneCodeEditor, side: Side, line: number, x: number, y: number): void {
    if (!this.menu) return;
    const sel = ed.getSelection();
    const hasSelection = !!sel && !sel.isEmpty();
    this.menu({
      path: side === 'file' ? this.filePath : this.diffPath,
      side,
      line,
      selection: hasSelection ? { startLine: sel.startLineNumber, endLine: sel.endLineNumber } : null,
      selectionText: hasSelection ? (ed.getModel()?.getValueInRange(sel) ?? '') : '',
      x,
      y,
    });
  }

  /** Shift+F10 / the ContextMenu key (fix round 1, item 1): `onContextMenu` is mouse-only, so a
   * keyboard invocation never reaches it. Opens at the cursor's screen position
   * (`getScrolledVisiblePosition`, relative to the editor; the editor's own box origin makes it
   * a page position), just below the line, like a real context menu would. */
  private openMenuAtCursor(ed: MonacoNs.editor.IStandaloneCodeEditor, side: Side): void {
    const pos = ed.getPosition();
    if (!pos) return;
    const rect = ed.getDomNode()?.getBoundingClientRect();
    const visible = ed.getScrolledVisiblePosition(pos);
    const x = (rect?.left ?? 0) + (visible?.left ?? 0);
    const y = (rect?.top ?? 0) + (visible?.top ?? 0) + (visible?.height ?? 0);
    this.openMenuAt(ed, side, pos.lineNumber, x, y);
  }

  private wireMenu(ed: MonacoNs.editor.IStandaloneCodeEditor, side: Side): void {
    ed.onContextMenu((e) => {
      if (!this.menu) return;
      // With `contextmenu: false` Monaco no longer suppresses the webview's native menu.
      e.event.preventDefault();
      this.openMenuAt(ed, side, e.target.position?.lineNumber ?? ed.getSelection()?.startLineNumber ?? 1, e.event.posx, e.event.posy);
    });
    const fromKeyboard = () => this.openMenuAtCursor(ed, side);
    ed.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.F10, fromKeyboard);
    ed.addCommand(monaco.KeyCode.ContextMenu, fromKeyboard);
  }
}

let host: Host | undefined;
let themeBound = false;
function bindEditorThemeOnce(): void {
  if (themeBound) return;
  themeBound = true;
  bindEditorTheme((name) => monaco.editor.setTheme(name));
}

/** The app's one host. The editor theme is defined before it's handed out, so the first editor
 * is created in it (see `ensureTheme`). Reached only through `loadMonacoHost`. */
export async function createHost(): Promise<MonacoHost> {
  await ensureTheme(monaco);
  // Monaco's setTheme is global: the shared editors all follow the app theme, no re-creation.
  bindEditorThemeOnce();
  return (host ??= new Host());
}
