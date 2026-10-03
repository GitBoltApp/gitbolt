import type * as MonacoNs from 'monaco-editor/editor/editor.api';

/** Monaco's own `lineNumbersMinChars`, back when no strip is shown. */
export const DEFAULT_LINE_NUMBER_CHARS = 5;
/** Room between the strip and the widest line number (px). */
export const NUMBER_GAP_PX = 8;

/** The editor's font metrics the strip needs (Monaco's `fontInfo`; the host reads it). */
export interface MarginFont {
  fontSize: number;
  lineHeight: number;
  maxDigitWidth: number;
}

/** The strip's overlay and the line geometry to place rows in it (scroll applied). */
export interface FileMargin {
  node: HTMLElement;
  lineTop(line: number): number;
  lineBottom(line: number): number;
  /** The first and last model line on screen (`last < first`: none). */
  visibleLines(): { first: number; last: number };
  /** Monaco's line box and font size: rows laid in the strip share the code's (one baseline). */
  metrics(): { lineHeight: number; fontSize: number };
  /** Scroll, layout, size, font and model changes move the rows; returns the removal. */
  onChange(cb: () => void): () => void;
}

/**
 * A strip in File View's margin (spec #3 §3.10, the blame gutter), LEFT of the line numbers
 * (blame | numbers | code, UX round 1 B.2): Monaco only lays the glyph margin there, which is a
 * line high, so the strip widens the line-number column instead (`lineNumbersMinChars`; Monaco
 * right-aligns the numbers in it) and an overlay widget covers that column's left part, up to the
 * widest number. The glyph margin is off meanwhile, so the strip starts at the editor's left
 * edge. Monaco never paints into the node; its owner does (`BlameGutter`, a portal).
 */
export class FileMarginStrip {
  private width = 0;
  /** The most of the editor's width the strip may take (0–1). */
  private share = 1;
  private chars = DEFAULT_LINE_NUMBER_CHARS;
  private node: HTMLElement | null = null;
  private subs: MonacoNs.IDisposable[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly ed: MonacoNs.editor.ICodeEditor;
  private readonly font: () => MarginFont;
  private readonly widget: MonacoNs.editor.IOverlayWidget = { getId: () => 'gitbolt.fileMargin', getDomNode: () => this.node!, getPosition: () => null };

  constructor(ed: MonacoNs.editor.ICodeEditor, font: () => MarginFont) {
    this.ed = ed;
    this.font = font;
  }

  /** What a new show must keep (`Host.presentFile` re-applies File View's options each show). */
  options(): { lineNumbersMinChars?: number; glyphMargin?: boolean } {
    return this.width > 0 ? { lineNumbersMinChars: this.chars, glyphMargin: false } : {};
  }

  /** `width` px, but at most `maxShare` of the editor's width (refit as the editor resizes). */
  set(width: number, maxShare = 1): FileMargin | null {
    this.width = Math.max(0, width);
    this.share = maxShare;
    const ed = this.ed;
    if (this.width === 0) {
      this.chars = DEFAULT_LINE_NUMBER_CHARS;
      ed.updateOptions({ lineNumbersMinChars: DEFAULT_LINE_NUMBER_CHARS, glyphMargin: true });
      if (this.node) ed.removeOverlayWidget(this.widget);
      this.node = null;
      for (const s of this.subs) s.dispose();
      this.subs = [];
      return null;
    }
    this.chars = this.fitChars();
    ed.updateOptions({ lineNumbersMinChars: this.chars, glyphMargin: false });
    if (!this.node) {
      this.node = document.createElement('div');
      this.node.className = 'file-margin';
      ed.addOverlayWidget(this.widget);
      const changed = () => { for (const l of [...this.listeners]) l(); };
      // A font or a line count with another digit count changes the numbers' width: refit.
      const refit = () => { this.refit(); this.place(); changed(); };
      this.subs = [
        ed.onDidScrollChange(changed),
        // A resize changes the strip's share of the editor too.
        ed.onDidLayoutChange(refit),
        ed.onDidChangeModel(refit),
        ed.onDidChangeModelContent(refit),
        ed.onDidChangeConfiguration(refit),
        ed.onDidContentSizeChange(changed),
      ];
    }
    this.place();
    const margin: FileMargin = {
      node: this.node,
      lineTop: (n) => ed.getTopForLineNumber(n) - ed.getScrollTop(),
      lineBottom: (n) => ed.getBottomForLineNumber(n) - ed.getScrollTop(),
      visibleLines: () => {
        const r = ed.getVisibleRanges();
        return { first: r[0]?.startLineNumber ?? 1, last: r.at(-1)?.endLineNumber ?? 0 };
      },
      metrics: () => {
        const f = this.font();
        return { lineHeight: f.lineHeight, fontSize: f.fontSize };
      },
      onChange: (cb) => {
        this.listeners.add(cb);
        return () => { this.listeners.delete(cb); };
      },
    };
    return margin;
  }

  /** The widest line number's digits (Monaco sizes the column by the model's line count). */
  private digits(): number {
    return String(this.ed.getModel()?.getLineCount() ?? 1).length;
  }

  /** Enough digit cells for the strip, the gap and the widest number. */
  private fitChars(): number {
    const w = this.font().maxDigitWidth || 8;
    return Math.ceil((this.stripWidth() + NUMBER_GAP_PX) / w) + this.digits();
  }

  /** The strip's width now: `width`, capped at its share of the editor (whose width the
   * line-number column never changes, so refitting on layout settles). */
  private stripWidth(): number {
    return Math.min(this.width, Math.floor(this.share * this.ed.getLayoutInfo().width));
  }

  private refit(): void {
    if (this.width === 0) return;
    const chars = this.fitChars();
    if (chars === this.chars) return;
    this.chars = chars;
    this.ed.updateOptions({ lineNumbersMinChars: chars });
  }

  private place(): void {
    if (!this.node) return;
    const info = this.ed.getLayoutInfo();
    const numbers = Math.ceil(this.digits() * (this.font().maxDigitWidth || 8)) + NUMBER_GAP_PX;
    const width = Math.max(0, info.lineNumbersLeft + info.lineNumbersWidth - info.glyphMarginLeft - numbers);
    Object.assign(this.node.style, { position: 'absolute', top: '0px', left: `${info.glyphMarginLeft}px`, width: `${width}px`, height: `${info.height}px` });
  }
}
