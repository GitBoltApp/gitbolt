import type * as MonacoNs from 'monaco-editor/editor/editor.api';
import { DEFAULT_DIFF_PREFS, type EditorDiffPrefs } from '../diffPrefs';
import { useEditorSettings } from '../editorSettings';
import { clampEditorFont, diffEditorOptions, EDITOR_SCROLLBAR, fileViewOptions } from '../options';
import { enableDeletedLineCopy } from './deletedCopy';
import { keepOriginalWrap } from './originalWrap';
import { HexPanes, type HexView } from './hexPanes';
import { FileMarginStrip, type FileMargin } from './fileMargin';
import { deletedLineAt, LineGutter, type LineGutterSpec } from './lineGutter';
import { captureAnchor, restoreAnchor, revealRange, type ScrollAnchor } from './scrollAnchor';
import { openTop, revealTop, stepTarget, type ChangeBox } from '../changeNav';
import { overflowLayer } from './overflow';
import { ReviewGutter, type ReviewGutterSpec } from './reviewGutter';
import { ReviewZones, type ReviewZoneSpec } from './reviewZones';
import { monaco } from './setup';
import { useAppState } from '../../app/state';
import { bindEditorTheme, currentEditorTheme } from '../../theme/editorThemes';
import { ensureLanguage, ensureTheme } from './shiki';

/** A line to open a diff at (a diff note's `file:line`): on the new side (`modified`) or the old;
 * with `end`, the lines `line` to `end` (a multi-line note's `file:start-end`). */
export interface DiffLine { side: 'original' | 'modified'; line: number; end?: number }
export interface DiffShowRequest {
  /** The target's key (repo/worktree and path): what `modifiedText` checks. */
  identity?: string; path: string; original: string; modified: string; language: string; prefs: EditorDiffPrefs; hunkZones?: HunkZoneRequest;
  /** Opens at this line, centred with the cursor on it, instead of at the first change. */
  line?: DiffLine;
}
export type { LineGutterSpec };
export type { FileMargin };
export type { ReviewZoneItem, ReviewZoneSpec } from './reviewZones';
export type { ReviewGutterSpec } from './reviewGutter';
/** Lines of one side of the diff (`start` to `end`, 1-based). */
export interface DiffLines { side: 'original' | 'modified'; start: number; end: number }
export type { HexShowRequest, HexView } from './hexPanes';
/** A hunk's header row (spec #2 §7.3): after modified line `after` (0: above line 1). */
export interface HunkZone { after: number }
/** A WIP diff's hunk header rows, shown with the diff (Hunk mode only): `zones` is waited for with
 * the diff's own computation, so the rows are laid out in the frame the diff appears in and
 * nothing moves when they fill. `placed` gets the rows' DOM nodes (`[]` outside Hunk mode) each
 * time they're laid out: this show, and a mode change after it. */
export interface HunkZoneRequest { zones: Promise<HunkZone[]>; placed(nodes: HTMLElement[]): void }
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
  /** Inline and Hunk mode: the old-side line of the deleted-lines zone the click was on. */
  deletedLine?: number;
  x: number;
  y: number;
}

export interface MonacoHost {
  /** `next`: the diff the attaching view will show. The one editor is shared, so it may still
   * hold another view's diff (the panel closed, then another commit's file opened, H6); it's
   * hidden until `showDiff` puts `next` on screen, so that one is never presented for a frame.
   * A show still in flight is the previous view's: dropped, so it can't land (and un-hide the
   * editor) under the attaching view before that view's own `showDiff` (K7). */
  attachDiff(el: HTMLElement, next?: DiffContent): void;
  detachDiff(el: HTMLElement): void;
  /** A kept (hidden, then shown again) panel's view (J16): true when the diff editor is still in
   * `el`, so it needn't attach again. It hides a diff other than `next` until `showDiff` puts
   * `next` on screen, as `attachDiff` does. False (nothing done) when it's elsewhere. */
  keepDiff(el: HTMLElement, next: DiffContent): boolean;
  /** Resolves once the diff is on screen. Monaco computes it off-screen first, so the previous
   * diff stays until the new one swaps in whole: decorations, Hunk mode's collapsed regions and
   * its first change centred, with the cursor on it (at the top instead when it shows there whole),
   * or `line` centred when asked for. That place is held through late relayouts until the user takes over, as `setDiffPrefs`'s.
   * A newer call makes an older one a no-op.
   * `attachDiff` must have run first: before that there's no diff editor, and it resolves
   * without showing anything. */
  showDiff(req: DiffShowRequest): Promise<void>;
  /** The user's mode and toggles, applied to the shown diff. The line at the viewport centre
   * stays there (the top or bottom, when scrolled to one), including after a recompute
   * (Ignore whitespace), until the user takes over (a pointer, the wheel, a key, Next/Previous
   * change) or another file shows. No jump to the first change: that's for a new file only. */
  setDiffPrefs(prefs: EditorDiffPrefs): void;
  /** Next: the first change starting below the viewport's centre line; Previous: the last one
   * ending above it (`stepTarget`), centred, with the cursor on it. Right after a step (or the
   * open), while the view is still where it was put, it goes on from that change. Wraps. */
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
  /** File View's margin strip (spec #3 §3.10, the blame gutter): `width` px reserved left of the
   * line numbers (at most `maxShare` of the editor), with a node laid over it; 0 removes it. `null` for 0, or before the file editor exists. */
  setFileMargin(width: number, maxShare?: number): FileMargin | null;
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
  /** File View's scroll position; `null` with no file shown (spec #5 §3.4: a place's scroll). */
  fileScrollTop(): number | null;
  /** Scrolls File View to `top`, at once (spec #5 §3.4: Back/Forward). */
  setFileScrollTop(top: number): void;
  /** File View's cursor and scroll, to put back after the rendered Markdown view (spec #5 §3.3). */
  fileViewState(): MonacoNs.editor.ICodeEditorViewState | null;
  restoreFileViewState(state: MonacoNs.editor.ICodeEditorViewState | null): void;
  /** Spec #2 §7.3: the gutter's per-line stage/unstage button (`LineGutter`); `null` removes it. */
  setLineGutter(spec: LineGutterSpec | null): void;
  /** Each selection in either editor (and again when it scrolls), as the lines it covers on that
   * side and where its last line is on screen; `null` when it's empty. `null` removes the listener. */
  onDiffSelection(cb: ((s: DiffSelection | null) => void) | null): void;
  /** The diff editor's cursor: its line, on the side holding the keyboard, else the new side
   * (where Next/Previous change puts it). `null` while no diff is attached. */
  diffCursor(): { side: 'original' | 'modified'; line: number } | null;
  /** Review mode's cards (spec 2026-10-08 §2): a view zone under each item's line, its card in a
   * layer over the editor (`spec.placed` gets the cards' nodes). Laid with each show of
   * `spec.path` (before it renders), and again on a mode change or a recompute; `null` removes them. */
  setReviewZones(spec: ReviewZoneSpec | null): void;
  /** Review mode's "+" in the glyph margin, on the lines that take a comment; `null` removes it. */
  setReviewGutter(spec: ReviewGutterSpec | null): void;
  /** The selection's lines on the side holding the keyboard (else the new side), or the cursor's
   * line when nothing is selected. `null` while no diff is attached. */
  diffLines(): DiffLines | null;
  /** Lines `start` to `end` of a side, as shown (`null` with no diff shown). */
  diffLineText(side: 'original' | 'modified', start: number, end: number): string[] | null;
  /** Next: the first review card (thread or draft) starting below the view's centre; Previous:
   * the last one ending above it; centred. Wraps. Its key, or `null` with none. */
  goToReviewZone(direction: 'next' | 'previous'): string | null;
  /** A binary's hex view (UX round 2, lane K) in `el`: editors of its own, hex | text per side,
   * until `dispose` (which the view calls when `el` goes). While it's on screen, Next/Previous
   * change, `focus` and `openFind` act on it, and the context menu is this host's. */
  hexView(el: HTMLElement): HexView;
}

type Side = EditorContextMenuEvent['side'];

/** A non-empty selection in the diff (spec #2 §7.3): the 1-based lines it covers on `side`, and
 * where its last line is on screen. */
export interface DiffSelection { side: 'original' | 'modified'; start: number; end: number; rect: { top: number; left: number; bottom: number } }
/** The height of a hunk's header row. */
export const HUNK_ZONE_PX = 24;
/** Monaco's own zones take its default ordinal (10000): a header row comes after them. */
const HUNK_ZONE_ORDINAL = 10001;

/** Lines of context above a change taller than the view when it's revealed (as Hunk mode's). */
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
/** A held place: a line at the viewport centre (a prefs change), the first change (an open), or
 * a note's lines (an open at a range, `revealRange`). */
type Hold = ScrollAnchor | 'first' | Required<DiffLine>;

type LineChange = MonacoNs.editor.ILineChange;
/** Each change's extent in the diff's scroll space, from whichever sides have its lines. Both
 * editors share that space: in Inline and Hunk the original editor is the old-line-number strip,
 * its deleted lines level with the modified side's zone for them (see `scrollAnchor.ts`). */
function changeBoxes(ed: MonacoNs.editor.IStandaloneDiffEditor, changes: LineChange[]): ChangeBox[] {
  const o = ed.getOriginalEditor();
  const m = ed.getModifiedEditor();
  return changes.map((c) => {
    const tops: number[] = [];
    const bottoms: number[] = [];
    if (c.originalEndLineNumber > 0) {
      tops.push(o.getTopForLineNumber(c.originalStartLineNumber));
      bottoms.push(o.getBottomForLineNumber(c.originalEndLineNumber));
    }
    if (c.modifiedEndLineNumber > 0) {
      tops.push(m.getTopForLineNumber(c.modifiedStartLineNumber));
      bottoms.push(m.getBottomForLineNumber(c.modifiedEndLineNumber));
    }
    return { top: Math.min(...tops), bottom: Math.max(...bottoms) };
  });
}
/** The modified line a change's cursor goes to. A pure deletion reports the line above it; its
 * removed lines show below that line. */
const changeLine = (c: LineChange) => (c.modifiedEndLineNumber === 0 ? c.modifiedStartLineNumber + 1 : c.modifiedStartLineNumber);
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
  private anchor: Hold | null = null;
  /** The change a reveal (the open's, a step's) put the view on, and the scroll it left: the next
   * step goes on from that change while the view is still there (`stepTarget`'s `current`). */
  private revealed: { index: number; top: number } | null = null;
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
  private prefs: EditorDiffPrefs = DEFAULT_DIFF_PREFS;
  private fileWrap = DEFAULT_DIFF_PREFS.wordWrap;
  private computedCount = 0;
  private menu: ((e: EditorContextMenuEvent) => void) | null = null;
  private margin: FileMarginStrip | null = null;
  private diffPath = '';
  private diffIdentity: string | undefined;
  private fileIdentity: string | undefined;
  private filePathShown: string | undefined;
  private filePath = '';
  private diffSeq = 0;
  private fileSeq = 0;
  private readonly ro = new ResizeObserver(() => this.layout());
  /** The boxes the editors were last attached to (and are observed in), until detached. */
  private diffBox: HTMLElement | null = null;
  private fileBox: HTMLElement | null = null;
  private keptTimer: ReturnType<typeof setTimeout> | undefined;
  private modEdit: { dispose(): void } | null = null;
  /** The shown diff's hunk header rows: what it asked for, and the view zones laid out now. */
  private hunkZones: { req: HunkZoneRequest; zones: HunkZone[] } | null = null;
  private zoneIds: string[] = [];
  private zoneNodes: HTMLElement[] = [];
  private zoneWidthSub: { dispose(): void } | null = null;
  private gutter: LineGutter | null = null;
  /** Review mode's cards (once a view asks), the spec asked for (kept for an editor not created
   * yet), and its gutter. */
  private review: ReviewZones | null = null;
  private reviewSpec: ReviewZoneSpec | null = null;
  private reviewGutter: ReviewGutter | null = null;
  private selSubs: { dispose(): void }[] = [];
  private fileEditSub: { dispose(): void } | null = null;
  /** The hex view on screen, if any (`hexView`). */
  private hex: HexPanes | null = null;
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
    this.diffSeq++;
    this.hideDiff(!!this.diffShown && !!next && !sameDiff(this.diffShown, next));
    // A previous box never detached (a kept panel unmounted while hidden, J16): stop observing it.
    if (this.diffBox && this.diffBox !== el) this.ro.unobserve(this.diffBox);
    this.diffBox = el;
    el.appendChild(this.diffEl);
    if (this.review) el.appendChild(this.review.layer);
    this.ro.observe(el);
    if (!this.diff) {
      this.diff = monaco.editor.createDiffEditor(this.diffEl, { ...diffEditorOptions(this.prefs, this.menu === null, sticky(), fontSize()), theme: currentEditorTheme(), overflowWidgetsDomNode: overflowLayer() });
      // A plain DOM signal that a diff (or a prefs recompute) is done, for e2e waits.
      this.diff.onDidUpdateDiff(() => {
        this.diffEl.dataset.diffComputed = String(++this.computedCount);
        // A recompute (Ignore whitespace) relayouts again once done: keep the anchored place, and
        // once the last one is in, the hold only waits for late relayouts (word wrap).
        if (this.anchor && this.pendingDiffs > 0 && --this.pendingDiffs === 0) this.holdFor(ANCHOR_HOLD_MS);
        this.onRelayout();
        // A recompute (Ignore whitespace) moves an old line's card in Inline and Hunk.
        this.review?.relayout();
      });
      this.wireMenu(this.diff.getOriginalEditor(), 'original');
      this.wireMenu(this.diff.getModifiedEditor(), 'modified');
      enableDeletedLineCopy(this.diff);
      keepOriginalWrap(this.diff.getOriginalEditor(), monaco.editor.EditorOption.wordWrapOverride2);
      // A relayout that lands later still (word wrap's line breaks, a recompute's view zones and
      // collapsed regions), or Monaco moving the view itself (recovering its viewport start):
      // keep the anchored place.
      const m = this.diff.getModifiedEditor();
      m.onDidContentSizeChange(() => this.onRelayout());
      m.onDidLayoutChange(() => this.onRelayout());
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
    if (this.reviewSpec && !this.review) this.setReviewZones(this.reviewSpec);
    this.layout();
  }

  keepDiff(el: HTMLElement, next: DiffContent): boolean {
    if (!this.diff || this.diffEl.parentElement !== el) return false;
    this.diffSeq++;
    this.hideDiff(!!this.diffShown && !!next && !sameDiff(this.diffShown, next));
    return true;
  }

  detachDiff(el: HTMLElement): void {
    this.dropAnchor();
    this.ro.unobserve(el);
    if (this.diffBox === el) this.diffBox = null;
    if (this.diffEl.parentElement === el) el.removeChild(this.diffEl);
    if (this.review?.layer.parentElement === el) el.removeChild(this.review.layer);
  }

  /** A failed show un-hides the editor: the view's error UI (and its Retry) takes over. Not a
   * replaced one's: the editor is the newer show's then. */
  async showDiff(req: DiffShowRequest): Promise<void> {
    const seq = ++this.diffSeq;
    try {
      await this.presentDiff(req, seq);
    } catch (e) {
      if (seq === this.diffSeq) this.hideDiff(false);
      throw e;
    }
  }

  private async presentDiff(req: DiffShowRequest, seq: number): Promise<void> {
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
    // The hunk rows come with the diff (fetched alongside it), so they're laid out in its frame.
    let zones: HunkZone[] = [];
    const zonesIn = req.hunkZones?.zones.then((z) => { zones = z; }, () => {});
    await withBackstop(Promise.all([view.waitForDiff(), zonesIn]).then(() => {}), DIFF_BACKSTOP_MS);
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
    this.clearHunkZones();
    // Zones belong to the view a model change replaces.
    this.review?.clear();
    ed.setModel(view);
    this.hunkZones = req.hunkZones ? { req: req.hunkZones, zones } : null;
    this.layHunkZones();
    // Review mode's cards, in this frame too.
    this.review?.shown(req.path, this.prefs.mode);
    // A save's reload keeps its place (below); any other show opens at the first change, before
    // the next frame renders, so the diff shows up already there.
    const kept = this.keptView?.diff && this.keptView.diffPath === req.path ? this.keptView.diff : null;
    this.revealed = null;
    if (!kept && req.line) this.openAtLine(ed, req.line);
    else if (!kept) this.openAtFirstChange(ed);
    // A new model gets a new view, which Monaco would paint empty and fill a frame later (the
    // "black frame"): draw both sides now, in this task.
    ed.getOriginalEditor().render(true);
    ed.getModifiedEditor().render(true);
    this.diffShown = { path: req.path, original: req.original, modified: req.modified };
    this.hideDiff(false);
    this.diffView?.dispose();
    for (const m of this.diffModels) m.dispose();
    this.diffView = view;
    this.diffModels = [original, modified];
    if (kept) ed.restoreViewState(kept);
    this.keptView = null;
  }

  /** A new diff opens at its first change (`openTop`: centred, or at the top when it shows there
   * whole), in every mode, with the cursor on it. Once per `showDiff`, never on a prefs change, so
   * it doesn't fight the user's own scrolling. The place is held like a prefs change's: what lays
   * out later (word wrap's line breaks, view zones, Hunk's collapsed regions, the editor's own
   * size) would move the change, so it's revealed again until the user takes over. */
  private openAtFirstChange(ed: MonacoNs.editor.IStandaloneDiffEditor): void {
    const first = ed.getLineChanges()?.[0];
    if (!first) return;
    ed.getModifiedEditor().setPosition({ lineNumber: this.clampLine(changeLine(first)), column: 1 });
    this.revealChange(ed, 0, true);
    this.anchor = 'first';
    this.holdFor(ANCHOR_HOLD_MS);
  }

  /** As `openAtFirstChange`, for a line asked for (a note's `file:line`): centred, with the cursor
   * on it in its side, and held through late relayouts as a prefs change's line is. A range
   * (`file:start-end`) is selected, the cursor on its first line, and centred (`revealRange`). */
  private openAtLine(ed: MonacoNs.editor.IStandaloneDiffEditor, at: DiffLine): void {
    const side = at.side === 'original' ? ed.getOriginalEditor() : ed.getModifiedEditor();
    const model = side.getModel();
    const clamp = (n: number) => Math.max(1, Math.min(n, model?.getLineCount() ?? n));
    const line = clamp(at.line);
    const end = clamp(at.end ?? line);
    if (end > line && model) {
      side.setSelection({ selectionStartLineNumber: end, selectionStartColumn: model.getLineMaxColumn(end), positionLineNumber: line, positionColumn: 1 });
      this.anchor = { side: at.side, line, end };
    } else {
      side.setPosition({ lineNumber: line, column: 1 });
      this.anchor = { side: at.side, line, fraction: 0.5 };
    }
    this.restore(ed, this.anchor);
    this.holdFor(ANCHOR_HOLD_MS);
  }

  /** Scrolls change `index` into place: `openTop` for the open, else `revealTop` (centred).
   * False when there's no such change. */
  private revealChange(ed: MonacoNs.editor.IStandaloneDiffEditor, index: number, open: boolean): boolean {
    const box = changeBoxes(ed, ed.getLineChanges() ?? [])[index];
    if (!box) return false;
    const m = ed.getModifiedEditor();
    const height = m.getLayoutInfo().height;
    const margin = REVEAL_CONTEXT_LINES * m.getOption(monaco.editor.EditorOption.lineHeight);
    this.restoring = true;
    try {
      m.setScrollTop(open ? openTop(box, height, margin) : revealTop(box, height, margin), SCROLL_IMMEDIATE);
    } finally {
      this.restoring = false;
    }
    this.revealed = { index, top: m.getScrollTop() };
    return true;
  }

  /** The change the view is still on, where a reveal left it; null once it's moved. */
  private revealedChange(): number | null {
    const m = this.diff?.getModifiedEditor();
    return m && this.revealed && Math.abs(m.getScrollTop() - this.revealed.top) <= 1 ? this.revealed.index : null;
  }

  private clampLine(line: number): number {
    return Math.max(1, Math.min(line, this.diff?.getModifiedEditor().getModel()?.getLineCount() ?? line));
  }

  setDiffPrefs(prefs: EditorDiffPrefs): void {
    const ed = this.diff;
    const recomputes = prefs.ignoreWhitespace !== this.prefs.ignoreWhitespace;
    // An anchor still held (a relayout or recompute not in yet) is the truer place than the
    // scroll now, whatever Monaco scrolled meanwhile. The open's first change only while the view
    // is still on it: a move we saw no input for is the user's too.
    const held = this.anchor === 'first' && this.revealedChange() === null ? null : this.anchor;
    const anchor = ed && this.diffModels.length ? (held ?? captureAnchor(ed, this.prefs.mode)) : null;
    this.applyDiffPrefs(prefs);
    // The view keeps a line now, not a change (and a recompute renumbers them): the steps go by
    // the centre line again, even where the scroll happens to be the same. The open's first
    // change is revealed again (`restore`).
    this.revealed = null;
    if (!ed || !anchor) return;
    this.anchor = anchor;
    this.restore(ed, anchor);
    if (recomputes) this.pendingDiffs++;
    this.holdFor(this.pendingDiffs > 0 ? ANCHOR_RECOMPUTE_MAX_MS : ANCHOR_HOLD_MS);
  }

  /** Scrolls back to `at`. */
  private restore(ed: MonacoNs.editor.IStandaloneDiffEditor, at: Hold): void {
    if (at === 'first') {
      this.revealChange(ed, 0, true);
      return;
    }
    this.restoring = true;
    try {
      if (typeof at === 'object' && 'end' in at) revealRange(ed, at, REVEAL_CONTEXT_LINES * ed.getModifiedEditor().getOption(monaco.editor.EditorOption.lineHeight));
      else restoreAnchor(ed, at);
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

  private applyDiffPrefs(prefs: EditorDiffPrefs): void {
    const modeChanged = prefs.mode !== this.prefs.mode;
    this.prefs = prefs;
    this.diff?.updateOptions(diffEditorOptions(prefs, this.menu === null, sticky(), fontSize()));
    if (modeChanged && this.diffModels.length) {
      this.layHunkZones();
      this.review?.shown(this.diffPath, prefs.mode);
    }
  }

  /** Removes the hunk header rows. */
  private clearHunkZones(): void {
    const ids = this.zoneIds;
    this.zoneIds = [];
    this.zoneNodes = [];
    if (ids.length) this.diff?.getModifiedEditor().changeViewZones((acc) => { for (const id of ids) acc.removeZone(id); });
  }

  /** Lays out the shown diff's hunk header rows: in Hunk mode only; Inline and
   * Split keep their lines together, with the gutter's line buttons instead. Each row is right
   * above its hunk's first line: after Monaco's own zones there (the "N hidden lines" bar). */
  private layHunkZones(): void {
    this.clearHunkZones();
    const ed = this.diff;
    const hz = this.hunkZones;
    if (!ed || !hz) return;
    const nodes: HTMLElement[] = [];
    if (this.prefs.mode === 'hunk' && hz.zones.length) {
      const mod = ed.getModifiedEditor();
      // A zone is as wide as the widest line; a row spans the editor's view, its buttons at the end.
      this.zoneWidthSub ??= mod.onDidLayoutChange(() => this.sizeHunkZones());
      mod.changeViewZones((acc) => {
        for (const z of hz.zones) {
          // Monaco sets the zone's own `display`: the row is a box inside it.
          const domNode = document.createElement('div');
          domNode.className = 'hunk-zone';
          const row = domNode.appendChild(document.createElement('div'));
          row.className = 'hunk-row';
          nodes.push(row);
          this.zoneIds.push(acc.addZone({ afterLineNumber: z.after, heightInPx: HUNK_ZONE_PX, domNode, ordinal: HUNK_ZONE_ORDINAL }));
        }
      });
      this.zoneNodes = nodes;
      this.sizeHunkZones();
    }
    hz.req.placed(nodes);
  }

  private sizeHunkZones(): void {
    const info = this.diff?.getModifiedEditor().getLayoutInfo();
    if (!info) return;
    // Clear of the vertical scrollbar, which Monaco lays over the content's right edge.
    const width = `${Math.max(0, info.contentWidth - Math.max(info.verticalScrollbarWidth, EDITOR_SCROLLBAR.verticalScrollbarSize) - 4)}px`;
    for (const n of this.zoneNodes) if (n.parentElement) n.parentElement.style.minWidth = width;
  }

  private dropAnchor(): void {
    this.anchor = null;
    this.pendingDiffs = 0;
    clearTimeout(this.anchorTimer);
  }

  goToChange(direction: 'next' | 'previous'): void {
    if (this.hex?.isShown()) return this.hex.goToChange(direction);
    // The user's own move (F7, Next/Previous change): a kept place mustn't pull the view back.
    this.dropAnchor();
    const ed = this.diff;
    if (!ed) return;
    const changes = ed.getLineChanges() ?? [];
    const m = ed.getModifiedEditor();
    const view = { top: m.getScrollTop(), height: m.getLayoutInfo().height };
    const i = stepTarget(changeBoxes(ed, changes), view, direction, this.revealedChange());
    if (i === null) return;
    m.setPosition({ lineNumber: this.clampLine(changeLine(changes[i]!)), column: 1 });
    this.revealChange(ed, i, false);
  }

  diffCursor(): { side: 'original' | 'modified'; line: number } | null {
    const ed = this.diff;
    if (!ed || !this.diffEl.parentElement) return null;
    // As `openFind`: the side holding the keyboard, else the new one (where Next/Previous change
    // puts the cursor).
    const side = ed.getOriginalEditor().hasTextFocus() ? 'original' : 'modified';
    const pos = (side === 'original' ? ed.getOriginalEditor() : ed.getModifiedEditor()).getPosition();
    return pos ? { side, line: pos.lineNumber } : null;
  }

  /** Hides the diff editor while it holds another diff than the view's (`hideUnless`), and review
   * mode's cards over it with it. */
  private hideDiff(hidden: boolean): void {
    setHidden(this.diffEl, hidden);
    if (this.review) setHidden(this.review.layer, hidden);
  }

  setReviewZones(spec: ReviewZoneSpec | null): void {
    this.reviewSpec = spec;
    // No review: its cards' layer and listeners go, so the diffs shown next (file history, a
    // commit) carry none of it. The next review makes them again.
    if (!spec) {
      this.review?.dispose();
      this.review = null;
      return;
    }
    if (!this.diff) return;
    if (!this.review) {
      const review = new ReviewZones(this.diff);
      this.review = review;
      if (this.diffBox) this.diffBox.appendChild(review.layer);
      setHidden(review.layer, this.diffEl.hasAttribute('inert'));
      // Input in a card is the user taking over, as in the editor (`attachDiff`).
      const drop = () => this.dropAnchor();
      for (const type of ['pointerdown', 'wheel', 'keydown'] as const) review.layer.addEventListener(type, drop, { capture: true, passive: true });
      // A drag from a folded thread's icon picks lines, as one from the +.
      review.pressIcon = (side, line, click) => this.reviewGutter?.press(side, line, click) ?? false;
      review.shown(this.diffModels.length ? this.diffPath : null, this.prefs.mode);
    }
    this.review.set(spec);
  }

  setReviewGutter(spec: ReviewGutterSpec | null): void {
    // As the cards (`setReviewZones`): no review, no + and none of its listeners on the editor.
    if (!spec) {
      this.reviewGutter?.dispose();
      this.reviewGutter = null;
      return;
    }
    if (!this.diff) return;
    if (!this.reviewGutter) {
      this.reviewGutter = new ReviewGutter(this.diff);
      // A folded thread's icon has its line: no + over it.
      this.reviewGutter.occupied = (side, line) => this.review?.iconAt(side, line) ?? false;
    }
    this.reviewGutter.set(spec);
  }

  diffLines(): DiffLines | null {
    const ed = this.diff;
    if (!ed || !this.diffEl.parentElement) return null;
    const side = ed.getOriginalEditor().hasTextFocus() ? 'original' : 'modified';
    const s = (side === 'original' ? ed.getOriginalEditor() : ed.getModifiedEditor()).getSelection();
    if (!s) return null;
    // A selection ending at column 1 of the next line covers the line above only.
    const end = s.endColumn === 1 && s.endLineNumber > s.startLineNumber ? s.endLineNumber - 1 : s.endLineNumber;
    return { side, start: s.startLineNumber, end };
  }

  diffLineText(side: 'original' | 'modified', start: number, end: number): string[] | null {
    const ed = this.diff;
    const model = (side === 'original' ? ed?.getOriginalEditor() : ed?.getModifiedEditor())?.getModel();
    if (!model || !this.diffModels.length) return null;
    const out: string[] = [];
    for (let n = Math.max(1, start); n <= Math.min(end, model.getLineCount()); n++) out.push(model.getLineContent(n));
    return out;
  }

  goToReviewZone(direction: 'next' | 'previous'): string | null {
    const ed = this.diff;
    if (!ed || !this.review) return null;
    // The user's own move, as Next/Previous change: a kept place mustn't pull the view back.
    this.dropAnchor();
    return this.review.goTo(direction, REVEAL_CONTEXT_LINES * ed.getModifiedEditor().getOption(monaco.editor.EditorOption.lineHeight));
  }

  attachFile(el: HTMLElement, next?: FileContent): void {
    this.fileSeq++;
    hideUnless(this.fileEl, this.fileShown, next, sameFile);
    if (this.fileBox && this.fileBox !== el) this.ro.unobserve(this.fileBox);
    this.fileBox = el;
    el.appendChild(this.fileEl);
    this.ro.observe(el);
    if (!this.file) {
      this.file = monaco.editor.create(this.fileEl, { ...fileViewOptions(this.fileWrap, this.menu === null, sticky(), fontSize()), theme: currentEditorTheme(), overflowWidgetsDomNode: overflowLayer() });
      this.wireMenu(this.file, 'file');
    }
    this.layout();
  }

  keepFile(el: HTMLElement, next: FileContent): boolean {
    if (!this.file || this.fileEl.parentElement !== el) return false;
    this.fileSeq++;
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
    const seq = ++this.fileSeq;
    try {
      await this.presentFile(req, seq);
    } catch (e) {
      if (seq === this.fileSeq) setHidden(this.fileEl, false);
      throw e;
    }
  }

  private async presentFile(req: FileShowRequest, seq: number): Promise<void> {
    this.fileWrap = req.wordWrap;
    const lang = await ensureLanguage(monaco, req.language);
    const ed = this.file;
    if (seq !== this.fileSeq || !ed) return;
    this.filePath = req.path;
    this.fileIdentity = req.identity;
    this.setFileEditable(false);
    ed.updateOptions({ ...fileViewOptions(this.fileWrap, this.menu === null, sticky(), fontSize()), ...this.margin?.options() });
    // The same content we already show (a save's reload): keep the model, so Monaco's undo stack survives.
    const same = this.fileModel && this.filePathShown === req.path && ed.getValue() === req.text && ed.getModel() === this.fileModel;
    const model = same ? this.fileModel! : monaco.editor.createModel(req.text, lang);
    if (!same) ed.setModel(model);
    this.filePathShown = req.path;
    this.fileShown = { path: req.path, text: req.text };
    setHidden(this.fileEl, false);
    if (this.fileModel !== model) this.fileModel?.dispose();
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

  setLineGutter(spec: LineGutterSpec | null): void {
    if (!this.diff || (!spec && !this.gutter)) return;
    (this.gutter ??= new LineGutter(this.diff)).set(spec);
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

  fileScrollTop(): number | null {
    return this.file && this.fileEl.parentElement && this.fileModel ? this.file.getScrollTop() : null;
  }

  setFileScrollTop(top: number): void {
    if (this.file && this.fileEl.parentElement) this.file.setScrollTop(top, SCROLL_IMMEDIATE);
  }

  fileViewState(): MonacoNs.editor.ICodeEditorViewState | null {
    return this.file && this.fileEl.parentElement ? this.file.saveViewState() : null;
  }

  restoreFileViewState(state: MonacoNs.editor.ICodeEditorViewState | null): void {
    if (state && this.file) this.file.restoreViewState(state);
  }

  setFileWordWrap(on: boolean): void {
    this.fileWrap = on;
    this.file?.updateOptions({ wordWrap: on ? 'on' : 'off' });
  }

  setFileMargin(width: number, maxShare?: number): FileMargin | null {
    const ed = this.file;
    if (!ed) return null;
    return (this.margin ??= new FileMarginStrip(ed, () => ed.getOption(monaco.editor.EditorOption.fontInfo))).set(width, maxShare);
  }

  hexView(el: HTMLElement): HexView {
    const view: HexPanes = new HexPanes(el, {
      menu: () => this.menu,
      onDispose: () => { if (this.hex === view) this.hex = null; },
    });
    this.hex = view;
    return view;
  }

  focus(): void {
    if (this.hex?.isShown()) return this.hex.focus();
    if (this.diff && this.diffEl.parentElement) this.diff.getModifiedEditor().focus();
    else if (this.file && this.fileEl.parentElement) this.file.focus();
  }

  openFind(): void {
    if (this.hex?.isShown()) return this.hex.openFind();
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
    this.hex?.setContextMenu(handler === null);
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
  private openMenuAt(ed: MonacoNs.editor.IStandaloneCodeEditor, side: Side, line: number, x: number, y: number, deletedLine?: number): void {
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
      ...(deletedLine === undefined ? {} : { deletedLine }),
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
      const t = e.target;
      const zone = side === 'modified' && this.diff && (t.type === monaco.editor.MouseTargetType.CONTENT_VIEW_ZONE || t.type === monaco.editor.MouseTargetType.GUTTER_VIEW_ZONE)
        ? deletedLineAt(this.diff, ed, t.detail.viewZoneId, t.detail.afterLineNumber, e.event.posy)
        : null;
      this.openMenuAt(ed, side, t.position?.lineNumber ?? ed.getSelection()?.startLineNumber ?? 1, e.event.posx, e.event.posy, zone?.line);
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
