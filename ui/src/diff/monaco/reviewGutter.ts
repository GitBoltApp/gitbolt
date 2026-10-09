import type * as MonacoNs from 'monaco-editor/editor/editor.api';
import { deletedLineAt, gutterHit, type GutterLines, type Hit } from './lineGutter';
import { monaco } from './setup';
import { hideTooltip, showTooltip } from '../../ui/tooltipStore';

type Side = 'original' | 'modified';
export const GLYPH_TIP = 'Comment on this line (drag for several)';
type Editor = MonacoNs.editor.ICodeEditor;

/** Review mode's gutter (spec 2026-10-08 §2): the lines that take a comment, and what a click or
 * a drag picks. */
export interface ReviewGutterSpec extends GutterLines {
  /** Lines `from` to `to` of `side`, in the order dragged (`from === to`: a click). */
  onPick(side: Side, from: number, to: number): void;
}

/** A drag from the +: the side its lines are on, the editor it started in (`edSide`; Inline's old
 * lines are in the modified editor's deleted-lines zones), and its lines so far. `click`: a press
 * on a folded thread's icon, run when it ends on its own line; `fixed`: its line takes no
 * comment, so it never becomes a drag. */
interface Drag { side: Side; ed: Editor; edSide: Side; from: number; to: number; click?: () => void; fixed?: boolean }

/**
 * The comment "+" (spec 2026-10-08 §2): a square in the glyph margin on the hovered line that
 * takes a comment, as the staging gutter's (`LineGutter`): an overlay widget, so it comes and goes
 * without moving anything. A click picks its line; a drag from it picks the lines it goes over, on
 * its side only, highlighted as it goes; Esc drops the drag.
 */
export class ReviewGutter {
  private spec: ReviewGutterSpec | null = null;
  private drag: Drag | null = null;
  private release: (() => void) | null = null;
  private readonly hides: (() => void)[] = [];
  /** What `dispose` undoes: each editor's widget and listeners. */
  private readonly offs: (() => void)[] = [];
  private readonly marks: Record<Side, MonacoNs.editor.IEditorDecorationsCollection>;
  private readonly diff: MonacoNs.editor.IStandaloneDiffEditor;

  constructor(diff: MonacoNs.editor.IStandaloneDiffEditor) {
    this.diff = diff;
    this.marks = { original: diff.getOriginalEditor().createDecorationsCollection(), modified: diff.getModifiedEditor().createDecorationsCollection() };
    this.wire('original', diff.getOriginalEditor());
    this.wire('modified', diff.getModifiedEditor());
  }

  set(spec: ReviewGutterSpec | null): void {
    this.spec = spec;
    if (spec) return;
    this.end(false);
    for (const h of this.hides) h();
  }

  /** Whether `edSide`'s editor shows a folded thread's icon at `line`: the icon has the line, so
   * no + shows there (`ReviewZones.iconAt`). */
  occupied: ((edSide: Side, line: number) => boolean) | null = null;

  /** A press on a folded thread's icon at `line` of `edSide`'s editor: dragged off its line, it
   * picks lines as a drag from the + does (on a line that takes a comment); released on it, it's
   * the icon's click. False while there's no review. */
  press(edSide: Side, line: number, click: () => void): boolean {
    const spec = this.spec;
    if (!spec) return false;
    const ed = edSide === 'original' ? this.diff.getOriginalEditor() : this.diff.getModifiedEditor();
    const fixed = !(edSide === 'original' ? spec.old : spec.new).has(line);
    this.start({ side: edSide, ed, edSide, from: line, to: line, click, fixed });
    return true;
  }

  /** Gone from the editor: its + (the overlay widgets) and its listeners. The host makes a new one
   * for the next review (the editor is shared with every diff). */
  dispose(): void {
    this.set(null);
    for (const off of this.offs) off();
    this.offs.length = 0;
  }

  private wire(edSide: Side, ed: Editor): void {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'review-glyph';
    btn.tabIndex = -1;
    btn.hidden = true;
    btn.setAttribute('aria-label', 'Comment on this line');
    // The app's tooltip, not a native title (its OS delay): beside the glyph, clear of the lines.
    let tip = false;
    const untip = () => {
      if (tip) hideTooltip();
      tip = false;
    };
    btn.addEventListener('mouseenter', () => { tip = true; showTooltip(btn, GLYPH_TIP, 0, 'right'); });
    btn.addEventListener('mouseleave', untip);
    const mark = btn.appendChild(document.createElement('span'));
    mark.setAttribute('aria-hidden', 'true');
    mark.textContent = '+';
    let at: Hit | null = null;
    const hide = () => {
      at = null;
      untip();
      btn.hidden = true;
    };
    const show = (hit: Hit) => {
      const info = ed.getLayoutInfo();
      const lh = ed.getOption(monaco.editor.EditorOption.lineHeight);
      at = hit;
      Object.assign(btn.style, { top: `${hit.top}px`, left: `${info.glyphMarginLeft}px`, width: `${Math.max(info.glyphMarginWidth, 16)}px`, height: `${lh}px` });
      btn.hidden = false;
    };
    this.hides.push(hide);
    const widget: MonacoNs.editor.IOverlayWidget = { getId: () => `gitbolt.reviewComment.${edSide}`, getDomNode: () => btn, getPosition: () => null };
    ed.addOverlayWidget(widget);
    this.offs.push(() => { untip(); ed.removeOverlayWidget(widget); });
    // The press is the button's: Monaco mustn't move the cursor or start a selection under it.
    btn.addEventListener('mousedown', (e) => {
      untip();
      e.preventDefault();
      e.stopPropagation();
      if (e.button === 0 && at && this.spec) this.start({ side: at.side, ed, edSide, from: at.line, to: at.line });
    });
    const T = monaco.editor.MouseTargetType;
    const subs = [] as MonacoNs.IDisposable[];
    this.offs.push(() => subs.forEach((d) => d.dispose()));
    subs.push(
      ed.onMouseMove((e) => {
        // Mid-drag the + stays where the drag started; over the button itself, it stays too.
        if (this.drag || e.target.type === T.OVERLAY_WIDGET) return;
        const hit = this.spec ? gutterHit(this.diff, edSide, ed, e, this.spec) : null;
        if (!hit || (hit.side === edSide && this.occupied?.(edSide, hit.line))) hide();
        else if (!at || hit.line !== at.line || hit.side !== at.side || btn.hidden) show(hit);
      }),
      ed.onMouseLeave((e) => {
        if (this.drag) return;
        if (!(e.event.browserEvent.relatedTarget instanceof Node && btn.contains(e.event.browserEvent.relatedTarget))) hide();
      }),
      ed.onDidScrollChange(() => { if (!this.drag) hide(); }),
      ed.onDidChangeModel(() => {
        this.end(false);
        hide();
      }),
    );
  }

  private start(d: Drag): void {
    // A drag whose mouseup never came (released outside the window): its listeners go first.
    this.end(false);
    this.drag = d;
    this.paint();
    const move = (e: MouseEvent) => {
      const n = this.lineAt(e.clientX, e.clientY);
      if (n === null || !this.drag || this.drag.fixed || n === this.drag.to) return;
      this.drag.to = n;
      this.paint();
    };
    const up = () => this.end(true);
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      this.end(false);
    };
    window.addEventListener('mousemove', move, true);
    window.addEventListener('mouseup', up, true);
    window.addEventListener('keydown', key, true);
    this.release = () => {
      window.removeEventListener('mousemove', move, true);
      window.removeEventListener('mouseup', up, true);
      window.removeEventListener('keydown', key, true);
    };
  }

  private end(pick: boolean): void {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    this.release?.();
    this.release = null;
    this.marks.original.clear();
    this.marks.modified.clear();
    if (!pick) return;
    if (d.click && d.from === d.to) d.click();
    else this.spec?.onPick(d.side, d.from, d.to);
  }

  /** The line of the drag's side under the pointer: a line of its own editor, or (an old line in
   * Inline and Hunk) one in the modified editor's deleted-lines zones. Null elsewhere. */
  private lineAt(x: number, y: number): number | null {
    const d = this.drag;
    const t = d?.ed.getTargetAtClientPoint(x, y);
    if (!d || !t) return null;
    if (d.side === d.edSide) return t.position?.lineNumber ?? null;
    const T = monaco.editor.MouseTargetType;
    if (t.type !== T.GUTTER_VIEW_ZONE && t.type !== T.CONTENT_VIEW_ZONE) return null;
    return deletedLineAt(this.diff, d.ed, t.detail.viewZoneId, t.detail.afterLineNumber, y)?.line ?? null;
  }

  /** The dragged lines, highlighted where their editor draws them (not inside a deleted-lines zone). */
  private paint(): void {
    const d = this.drag;
    if (!d || d.side !== d.edSide) return;
    // A press on an icon is a click until it leaves the line.
    if (d.click && d.from === d.to) return void this.marks[d.side].clear();
    const [lo, hi] = d.from <= d.to ? [d.from, d.to] : [d.to, d.from];
    this.marks[d.side].set([{ range: { startLineNumber: lo, startColumn: 1, endLineNumber: hi, endColumn: 1 }, options: { isWholeLine: true, className: 'review-drag', marginClassName: 'review-drag' } }]);
  }
}
