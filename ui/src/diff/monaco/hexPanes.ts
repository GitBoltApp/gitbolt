import type * as MonacoNs from 'monaco-editor/editor/editor.api';
import type { HexSide } from '../../api/gen/HexSide';
import { useAppState } from '../../app/state';
import { currentEditorTheme } from '../../theme/editorThemes';
import { byteRange, byteRuns, changedRows, charText, dumpBytes, hexRowChars, hexText, mergeBlocks, NARROW_ROW_BYTES, offsetLabel, ROW_BYTES, rowsOf, runsIn, selectedBytes, stepChange, type ByteRun, type PaneKind } from '../hexModel';
import { clampEditorFont, EDITOR_SCROLLBAR } from '../options';
import { overflowLayer } from './overflow';
import { monaco } from './setup';

/** What the hex view shows (UX round 2, lane K): File View, one side's bytes; Diff View, both
 * sides' (one for an added or deleted file), byte i against byte i. */
export interface HexShowRequest { path: string; file: boolean; old: HexSide | null; new: HexSide | null }

/** A binary's hex view in an element: hex | text per side, each a read-only Monaco editor. */
export interface HexView {
  /** Shows `req` now, painted in this task: the same path keeps its scroll position (a reload),
   * another starts at the top, or a diff at its first change. */
  show(req: HexShowRequest): void;
  dispose(): void;
}

type Which = 'old' | 'new' | 'file';
type Editor = MonacoNs.editor.IStandaloneCodeEditor;
type Decorations = MonacoNs.editor.IEditorDecorationsCollection;
type Block = { first: number; last: number };
interface Pane {
  kind: PaneKind;
  box: HTMLElement;
  ed: Editor;
  model: MonacoNs.editor.ITextModel | null;
  /** The diff's colours around the viewport (`HexPanes.colourWindow`). */
  near: Decorations;
  /** What's decorated whole: the padding rows. */
  whole: Decorations;
  /** The bytes selected in the side's other pane. */
  mirror: Decorations;
}
interface Side { which: Which; box: HTMLElement; hex: Pane; text: Pane; size: number }

/** The menu the host shows for a right-click in a pane (`EditorContextMenuEvent`'s fields). */
export interface HexMenuEvent { path: string; side: 'original' | 'modified' | 'file'; line: number; selection: { startLine: number; endLine: number } | null; selectionText: string; x: number; y: number }
export interface HexHooks { menu(): ((e: HexMenuEvent) => void) | null; onDispose(): void }

/** Rows of context above a change that Next/Previous change (and a diff's first show) scroll to. */
const CONTEXT_ROWS = 3;
/** Monaco's `ScrollType.Immediate`. */
const SCROLL_IMMEDIATE = 1;
/** Room after a pane's last column, for the cursor, in px. */
const PANE_PAD_PX = 4;
/** The view's one vertical scrollbar (the app's slim native one, tokens.css). */
const BAR_PX = 10;
/** At most this many marks on the scrollbar: closer changes share one. */
const RULER_MARKS = 400;

const MENU_SIDE = { old: 'original', new: 'modified', file: 'file' } as const;

function paneOptions(kind: PaneKind, contextmenu: boolean): MonacoNs.editor.IStandaloneEditorConstructionOptions {
  return {
    readOnly: true,
    automaticLayout: false,
    contextmenu,
    fontSize: clampEditorFont(useAppState.getState().settings.editorFontSize),
    theme: currentEditorTheme(),
    fixedOverflowWidgets: true,
    overflowWidgetsDomNode: overflowLayer(),
    // The hex pane's gutter is the offset (`lineNumbers` set per show); the text pane has none.
    lineNumbers: kind === 'hex' ? () => '' : 'off',
    lineNumbersMinChars: 8,
    lineDecorationsWidth: kind === 'hex' ? 10 : 6,
    glyphMargin: false,
    folding: false,
    minimap: { enabled: false },
    stickyScroll: { enabled: false },
    wordWrap: 'off',
    renderLineHighlight: 'none',
    renderValidationDecorations: 'off',
    renderWhitespace: 'none',
    matchBrackets: 'never',
    occurrencesHighlight: 'off',
    selectionHighlight: false,
    links: false,
    hover: { enabled: 'off' },
    codeLens: false,
    colorDecorators: false,
    guides: { indentation: false },
    unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false, nonBasicASCII: false },
    // No vertical scrollbar of its own (none reserved either): the view has one, at its far
    // right, with the changes' marks on it; the panes scroll together (`HexPanes.createPane`).
    scrollbar: { ...EDITOR_SCROLLBAR, vertical: 'hidden', verticalScrollbarSize: 0, horizontal: 'auto', alwaysConsumeMouseWheel: true },
    // No room kept past a row's end: a pane exactly as wide as its rows never scrolls sideways.
    scrollBeyondLastColumn: 0,
    overviewRulerLanes: 0,
    overviewRulerBorder: false,
    hideCursorInOverviewRuler: true,
  };
}

/** The cells of bytes [start, end) in a pane of `kind`, `per` bytes a row. */
const cells = (kind: PaneKind, start: number, end: number, per: number): MonacoNs.IRange => {
  const r = byteRange(kind, start, end, per);
  return { startLineNumber: r.startLine, startColumn: r.startColumn, endLineNumber: r.endLine, endColumn: r.endColumn };
};
const rows = (first: number, last: number): MonacoNs.IRange => ({ startLineNumber: first, startColumn: 1, endLineNumber: last, endColumn: 1 });
/** The diff colours' tone on a side: the old side's are removed bytes, the new side's added. */
const toneOf = (which: Which) => (which === 'old' ? 'removed' : 'inserted');

export class HexPanes implements HexView {
  private readonly el: HTMLElement;
  private readonly hooks: HexHooks;
  private sides: Side[] = [];
  private path = '';
  private file = false;
  private rowCount = 1;
  /** Bytes per row: 16 when every side fits at that width, else 8 (`choosePer`). */
  private per = ROW_BYTES;
  /** Each side's bytes, to lay out again when the bytes per row change. */
  private bytes: Uint8Array[] = [];
  private runs: ByteRun[] = [];
  private blocks: Block[] = [];
  /** The rows the diff's colours are drawn for now (`colourWindow`); null: none yet. */
  private coloured: Block | null = null;
  /** The editor the user is scrolling (the last one a pointer, the wheel or the keyboard was in):
   * only its scroll events move the others, so they never feed back. */
  private driver: Editor | null = null;
  private lastFocused: Editor | null = null;
  private readonly ro = new ResizeObserver(() => this.layout());
  private readonly unsubFont: () => void;
  private disposed = false;
  /** The view's one vertical scrollbar, at its far right: a native scroller over a spacer as tall
   * as the editors' content, with the changes' marks under it. */
  private readonly bar = document.createElement('div');
  private readonly scroller = document.createElement('div');
  private readonly spacer = document.createElement('div');
  private readonly marks = document.createElement('div');

  constructor(el: HTMLElement, hooks: HexHooks) {
    this.el = el;
    this.hooks = hooks;
    this.bar.className = 'hex-bar';
    this.marks.className = 'hex-marks';
    this.scroller.className = 'hex-scroller';
    this.scroller.appendChild(this.spacer);
    this.bar.append(this.marks, this.scroller);
    el.appendChild(this.bar);
    // The scrollbar dragged (or wheeled over): the editors follow. Its own echo of an editor's
    // scroll (`syncBar`) is already where they are.
    this.scroller.addEventListener('scroll', () => {
      if (!this.sides.length || Math.abs(this.scroller.scrollTop - this.primary().ed.getScrollTop()) < 1) return;
      this.scrollAll(this.scroller.scrollTop);
    });
    this.ro.observe(el);
    this.unsubFont = useAppState.subscribe((s, prev) => {
      if (s.settings.editorFontSize === prev.settings.editorFontSize) return;
      const fontSize = clampEditorFont(s.settings.editorFontSize);
      for (const ed of this.editors()) ed.updateOptions({ fontSize });
      this.layout();
    });
  }

  private editors(): Editor[] {
    return this.sides.flatMap((s) => [s.hex.ed, s.text.ed]);
  }

  show(req: HexShowRequest): void {
    if (this.disposed) return;
    const wanted: { which: Which; side: HexSide | null }[] = req.file
      ? [{ which: 'file', side: req.new ?? req.old }]
      : [...(req.old ? [{ which: 'old' as const, side: req.old }] : []), ...(req.new ? [{ which: 'new' as const, side: req.new }] : [])];
    if (!wanted.length) wanted.push({ which: req.file ? 'file' : 'new', side: null });
    const same = req.path === this.path && req.file === this.file;
    const at = same ? this.topByte() : null;
    // The editors stay from file to file; a side more or less is made or let go.
    while (this.sides.length > wanted.length) this.disposeSide(this.sides.pop()!);
    while (this.sides.length < wanted.length) this.sides.push(this.createSide());
    this.path = req.path;
    this.file = req.file;
    this.bytes = wanted.map((w) => dumpBytes(w.side));
    this.sides.forEach((s, i) => {
      s.which = wanted[i].which;
      s.box.dataset.side = s.which;
      s.size = this.bytes[i].length;
    });
    const b = this.bytes;
    this.runs = req.file ? [] : b.length === 2 ? byteRuns(b[0], b[1]) : b[0].length ? [{ start: 0, end: b[0].length, kind: wanted[0].which === 'old' ? 'removed' : 'added' }] : [];
    this.per = this.choosePer();
    this.fill(at);
  }

  /** Lays the bytes out at `per` a row: the editors' texts and offsets, the diff's colours, the
   * panes' widths. `at`: the byte (fractional rows included) to keep at the top; null, a new file:
   * the top, or a diff's first change. */
  private fill(at: number | null): void {
    const per = this.per;
    this.setWidths();
    this.rowCount = Math.max(1, ...this.bytes.map((b) => rowsOf(b.length, per)));
    this.blocks = changedRows(this.runs, per);
    this.coloured = null;
    this.sides.forEach((s, i) => {
      const size = s.size;
      s.hex.ed.updateOptions({ lineNumbers: (n: number) => offsetLabel(n, size, per) });
      this.setModel(s.hex, hexText(this.bytes[i], per, this.rowCount));
      this.setModel(s.text, charText(this.bytes[i], per, this.rowCount));
      for (const p of [s.hex, s.text]) {
        p.mirror.clear();
        p.near.clear();
        p.whole.set(this.padding(s));
      }
    });
    this.layoutEditors();
    this.markChanges();
    const ed = this.primary().ed;
    let to = 0;
    if (at !== null) to = (at / per) * this.lineHeight();
    else if (this.blocks.length) {
      const first = this.blocks[0].first;
      if (ed.getTopForLineNumber(first + 1) > ed.getLayoutInfo().height) to = ed.getTopForLineNumber(Math.max(1, first - CONTEXT_ROWS));
    }
    this.scrollAll(to, at === null ? 0 : undefined);
    // A new model gets a view that Monaco would paint a frame later: draw it now, in this task.
    for (const e of this.editors()) e.render(true);
  }

  private lineHeight(): number {
    return this.primary().ed.getOption(monaco.editor.EditorOption.lineHeight);
  }

  /** The byte at the top of the view, fractional rows included. */
  private topByte(): number {
    if (!this.sides.length) return 0;
    return (this.primary().ed.getScrollTop() / this.lineHeight()) * this.per;
  }

  private setModel(p: Pane, text: string): void {
    const model = monaco.editor.createModel(text);
    p.ed.setModel(model);
    p.model?.dispose();
    p.model = model;
  }

  /** A side's rows past its end, hatched. */
  private padding(s: Side): MonacoNs.editor.IModelDeltaDecoration[] {
    const own = rowsOf(s.size, this.per);
    return own < this.rowCount ? [{ range: rows(own + 1, this.rowCount), options: { isWholeLine: true, className: 'hex-pad' } }] : [];
  }

  /** The changes' marks on the view's scrollbar, one per side's tone (old red, new green, each
   * half the width in a diff of both), closer changes sharing one. */
  private markChanges(): void {
    const tones = this.file ? [] : this.sides.map((s) => toneOf(s.which));
    const marks = mergeBlocks(this.blocks, Math.floor(this.rowCount / RULER_MARKS));
    const nodes: HTMLElement[] = [];
    for (const b of marks) {
      tones.forEach((tone, i) => {
        const n = document.createElement('div');
        n.className = `hex-mark hex-mark-${tone}`;
        Object.assign(n.style, {
          top: `${((b.first - 1) / this.rowCount) * 100}%`,
          height: `max(2px, ${((b.last - b.first + 1) / this.rowCount) * 100}%)`,
          left: `${(i / tones.length) * 100}%`,
          width: `${100 / tones.length}%`,
        });
        nodes.push(n);
      });
    }
    this.marks.replaceChildren(...nodes);
  }

  /** The scrollbar's content as tall as the editors', at their scroll position. */
  private syncBar(): void {
    if (!this.sides.length) return;
    const ed = this.primary().ed;
    this.spacer.style.height = `${ed.getScrollHeight()}px`;
    if (Math.abs(this.scroller.scrollTop - ed.getScrollTop()) >= 1) this.scroller.scrollTop = ed.getScrollTop();
  }

  /**
   * The diff's colours for the rows around the viewport (a screen above and below it): the
   * changed bytes in both panes, and the rows they're on. Again when a scroll or a resize leaves
   * that range. Drawn for all of a 256 KB diff at once, they took seconds.
   */
  private colourWindow(): void {
    if (this.file || !this.runs.length || !this.sides.length) return;
    const ed = this.primary().ed;
    const seen = ed.getVisibleRanges()[0];
    const first = seen?.startLineNumber ?? 1;
    const last = seen?.endLineNumber ?? 1;
    const c = this.coloured;
    if (c && c.first <= first && last <= c.last) return;
    const span = last - first + 1;
    const from = Math.max(1, first - span);
    const to = Math.min(this.rowCount, last + span);
    this.coloured = { first: from, last: to };
    const per = this.per;
    const runs = runsIn(this.runs, (from - 1) * per, to * per);
    const blocks = this.blocks.filter((b) => b.last >= from && b.first <= to);
    for (const s of this.sides) {
      const tone = toneOf(s.which);
      const own = rowsOf(s.size, per);
      for (const p of [s.hex, s.text]) {
        const out: MonacoNs.editor.IModelDeltaDecoration[] = [];
        for (const r of runs) {
          const end = Math.min(r.end, s.size);
          if (r.start < end) out.push({ range: cells(p.kind, r.start, end, per), options: { inlineClassName: `hex-${tone}` } });
        }
        for (const b of blocks) {
          const top = Math.max(b.first, from);
          const bottom = Math.min(b.last, to, own);
          if (top <= bottom) out.push({ range: rows(top, bottom), options: { isWholeLine: true, className: `hex-row-${tone}` } });
        }
        p.near.set(out);
      }
    }
  }

  private createSide(): Side {
    const box = document.createElement('div');
    box.className = 'hex-side';
    this.el.insertBefore(box, this.bar);
    const which = () => side.which;
    const side: Side = { which: 'file', box, size: 0, hex: this.createPane(box, 'hex', which), text: this.createPane(box, 'text', which) };
    // Selecting bytes in one pane shows the same bytes in the other, until it loses focus.
    for (const [from, to] of [[side.hex, side.text], [side.text, side.hex]] as const) {
      from.ed.onDidChangeCursorSelection((e) => {
        const sel = e.selection;
        const range = sel.isEmpty() ? null : selectedBytes(from.kind, { startLine: sel.startLineNumber, startColumn: sel.startColumn, endLine: sel.endLineNumber, endColumn: sel.endColumn }, side.size, this.per);
        if (!range) to.mirror.clear();
        else to.mirror.set([{ range: cells(to.kind, range[0], range[1], this.per), options: { inlineClassName: 'hex-mirror' } }]);
      });
      from.ed.onDidBlurEditorText(() => to.mirror.clear());
    }
    return side;
  }

  private createPane(sideBox: HTMLElement, kind: PaneKind, which: () => Which): Pane {
    const box = document.createElement('div');
    box.className = `hex-pane hex-pane-${kind}`;
    sideBox.appendChild(box);
    const ed = monaco.editor.create(box, paneOptions(kind, this.hooks.menu() === null));
    const pane: Pane = { kind, box, ed, model: null, near: ed.createDecorationsCollection(), whole: ed.createDecorationsCollection(), mirror: ed.createDecorationsCollection() };
    const drive = () => { this.driver = ed; };
    box.addEventListener('pointerdown', drive, { capture: true });
    box.addEventListener('wheel', drive, { capture: true, passive: true });
    box.addEventListener('keydown', drive, { capture: true });
    ed.onDidFocusEditorText(() => { this.lastFocused = ed; });
    ed.onDidScrollChange((e) => {
      if (this.driver !== ed) return;
      for (const other of this.editors()) {
        if (other === ed) continue;
        if (e.scrollTopChanged) other.setScrollTop(e.scrollTop, SCROLL_IMMEDIATE);
        // Hex with hex and text with text: the same columns.
        if (e.scrollLeftChanged && this.kindOf(other) === kind) other.setScrollLeft(e.scrollLeft, SCROLL_IMMEDIATE);
      }
      if (e.scrollTopChanged) {
        this.colourWindow();
        this.syncBar();
      }
    });
    ed.onContextMenu((e) => {
      const menu = this.hooks.menu();
      if (!menu) return;
      e.event.preventDefault();
      const sel = ed.getSelection();
      const has = !!sel && !sel.isEmpty();
      menu({
        path: this.path,
        side: MENU_SIDE[which()],
        line: e.target.position?.lineNumber ?? sel?.startLineNumber ?? 1,
        selection: has ? { startLine: sel.startLineNumber, endLine: sel.endLineNumber } : null,
        selectionText: has ? (ed.getModel()?.getValueInRange(sel) ?? '') : '',
        x: e.event.posx,
        y: e.event.posy,
      });
    });
    ed.onDidChangeConfiguration((e) => { if (e.hasChanged(monaco.editor.EditorOption.fontInfo)) this.layout(); });
    return pane;
  }

  private kindOf(ed: Editor): PaneKind {
    return this.sides.some((s) => s.hex.ed === ed) ? 'hex' : 'text';
  }

  /** Each pane's width for its content at `per` bytes a row, at the font's measured character
   * width: the hex pane's offsets and bytes, the text pane's characters and border. Nothing
   * scrolls sideways at that width. */
  private widths(per: number): { hex: number; text: number } {
    const s = this.sides[0];
    const width = (p: Pane, chars: number) => {
      const charW = p.ed.getOption(monaco.editor.EditorOption.fontInfo).typicalHalfwidthCharacterWidth;
      return Math.ceil(p.ed.getLayoutInfo().contentLeft + chars * charW + PANE_PAD_PX);
    };
    return { hex: width(s.hex, hexRowChars(per)), text: width(s.text, per) + 1 };
  }

  /** 16 bytes a row when every side fits at that width (with the dividers and the scrollbar),
   * else 8. */
  private choosePer(): number {
    const room = this.el.clientWidth;
    if (!this.sides.length || room <= 0) return this.per;
    const w = this.widths(ROW_BYTES);
    return this.sides.length * (w.hex + w.text + 1) + BAR_PX <= room ? ROW_BYTES : NARROW_ROW_BYTES;
  }

  /** The panes' widths (CSS variables on the view): the room left over is after the last side. */
  private setWidths(): void {
    if (!this.sides.length) return;
    const w = this.widths(this.per);
    this.el.style.setProperty('--hex-pane-w', `${w.hex}px`);
    this.el.style.setProperty('--hex-text-w', `${w.text}px`);
    this.el.dataset.rowBytes = String(this.per);
  }

  /** A resize or a font change: 16 or 8 bytes a row again (laid out anew, the same byte at the
   * top, when that changes), the panes' widths, the editors' sizes. */
  layout(): void {
    if (!this.sides.length || this.disposed) return;
    const per = this.choosePer();
    if (per !== this.per && this.bytes.length) {
      const at = this.topByte();
      this.per = per;
      this.fill(at);
      return;
    }
    this.setWidths();
    this.layoutEditors();
    // Taller: more rows on screen than were coloured, and more room to scroll.
    this.colourWindow();
    this.syncBar();
  }

  private layoutEditors(): void {
    for (const s of this.sides) {
      for (const p of [s.hex, s.text]) {
        const width = p.box.clientWidth;
        const height = p.box.clientHeight;
        if (width > 0 && height > 0) p.ed.layout({ width, height });
      }
    }
  }

  private scrollAll(top: number, left?: number): void {
    const driver = this.driver;
    this.driver = null;
    for (const ed of this.editors()) {
      ed.setScrollTop(top, SCROLL_IMMEDIATE);
      if (left !== undefined) ed.setScrollLeft(left, SCROLL_IMMEDIATE);
    }
    this.driver = driver;
    this.colourWindow();
    this.syncBar();
  }

  /** The pane whose cursor Next/Previous change go from by default: the new side's hex. */
  private primary(): Pane {
    const s = this.sides.find((x) => x.which !== 'old') ?? this.sides[0];
    return s.hex;
  }

  isShown(): boolean {
    return !this.disposed && this.el.isConnected && this.sides.length > 0;
  }

  goToChange(dir: 'next' | 'previous'): void {
    if (this.file || !this.sides.length) return;
    const from = this.lastFocused && this.editors().includes(this.lastFocused) ? this.lastFocused : this.primary().ed;
    const i = stepChange(this.blocks, from.getPosition()?.lineNumber ?? 1, dir);
    if (i < 0) return;
    const line = this.blocks[i].first;
    for (const ed of this.editors()) ed.setPosition({ lineNumber: line, column: 1 });
    this.scrollAll(this.primary().ed.getTopForLineNumber(Math.max(1, line - CONTEXT_ROWS)));
  }

  focus(): void {
    if (this.sides.length) this.primary().ed.focus();
  }

  openFind(): void {
    if (!this.sides.length) return;
    const ed = this.editors().find((e) => e.hasTextFocus()) ?? this.primary().ed;
    ed.focus();
    void ed.getAction('actions.find')?.run();
  }

  setContextMenu(on: boolean): void {
    for (const ed of this.editors()) ed.updateOptions({ contextmenu: on });
  }

  private disposeSide(s: Side): void {
    for (const p of [s.hex, s.text]) {
      if (this.driver === p.ed) this.driver = null;
      if (this.lastFocused === p.ed) this.lastFocused = null;
      p.ed.dispose();
      p.model?.dispose();
    }
    s.box.remove();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.ro.disconnect();
    this.unsubFont();
    for (const s of this.sides) this.disposeSide(s);
    this.sides = [];
    this.el.style.removeProperty('--hex-pane-w');
    this.el.style.removeProperty('--hex-text-w');
    delete this.el.dataset.rowBytes;
    this.bar.remove();
    this.hooks.onDispose();
  }
}
