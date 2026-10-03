import type * as MonacoNs from 'monaco-editor/editor/editor.api';

/** Monaco's own `lineDecorationsWidth` (px), back when no strip is shown. */
export const DEFAULT_DECORATIONS_PX = 10;

/** The strip's overlay and the line geometry to place rows in it (scroll applied). */
export interface FileMargin {
  node: HTMLElement;
  lineTop(line: number): number;
  lineBottom(line: number): number;
  /** The first and last model line on screen (`last < first`: none). */
  visibleLines(): { first: number; last: number };
  /** Scroll, layout, size and model changes move the rows; returns the removal. */
  onChange(cb: () => void): () => void;
}

/**
 * A strip in File View's margin (spec #3 §3.10, the blame gutter): `lineDecorationsWidth`
 * widened to `width` px between the line numbers and the text (folding off: its chevrons live
 * there), and an overlay widget laid exactly over it, as `LineGutter` lays its button over the
 * glyph margin. Monaco never paints into the node; its owner does (`BlameGutter`, a portal).
 */
export class FileMarginStrip {
  private width = 0;
  private node: HTMLElement | null = null;
  private subs: MonacoNs.IDisposable[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly ed: MonacoNs.editor.ICodeEditor;
  private readonly widget: MonacoNs.editor.IOverlayWidget = { getId: () => 'gitbolt.fileMargin', getDomNode: () => this.node!, getPosition: () => null };

  constructor(ed: MonacoNs.editor.ICodeEditor) {
    this.ed = ed;
  }

  /** What a new show must keep (`Host.presentFile` re-applies File View's options each show). */
  options(): { lineDecorationsWidth?: number; folding?: boolean } {
    return this.width > 0 ? { lineDecorationsWidth: this.width, folding: false } : {};
  }

  set(width: number): FileMargin | null {
    this.width = Math.max(0, width);
    const ed = this.ed;
    if (this.width === 0) {
      ed.updateOptions({ lineDecorationsWidth: DEFAULT_DECORATIONS_PX, folding: true });
      if (this.node) ed.removeOverlayWidget(this.widget);
      this.node = null;
      for (const s of this.subs) s.dispose();
      this.subs = [];
      return null;
    }
    ed.updateOptions({ lineDecorationsWidth: this.width, folding: false });
    if (!this.node) {
      this.node = document.createElement('div');
      this.node.className = 'file-margin';
      ed.addOverlayWidget(this.widget);
      const changed = () => { for (const l of [...this.listeners]) l(); };
      this.subs = [
        ed.onDidScrollChange(changed),
        ed.onDidLayoutChange(() => { this.place(); changed(); }),
        ed.onDidChangeModel(changed),
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
      onChange: (cb) => {
        this.listeners.add(cb);
        return () => { this.listeners.delete(cb); };
      },
    };
    return margin;
  }

  private place(): void {
    if (!this.node) return;
    const info = this.ed.getLayoutInfo();
    Object.assign(this.node.style, { position: 'absolute', top: '0px', left: `${info.decorationsLeft}px`, width: `${info.decorationsWidth}px`, height: `${info.height}px` });
  }
}
