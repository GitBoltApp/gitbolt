import type * as MonacoNs from 'monaco-editor/editor/editor.api';
import { lineOfSegment, zoneChange } from './deletedCopy';
import { monaco } from './setup';

type Side = 'original' | 'modified';

/** What the gutter's line button acts on (spec #2 §7.3): the changed lines of git's hunks, by
 * side (`old`: `-` lines, `new`: `+` lines), staged (−, unstage) or not (+, stage). `disabled`:
 * why it can't act now (unsaved edits, a queued commit), shown as its tooltip. */
export interface LineGutterSpec {
  old: ReadonlySet<number>;
  new: ReadonlySet<number>;
  staged: boolean;
  disabled: string | null;
  /** `side` is the line's: `original` for a `-` line (an old-side number), else `modified`. */
  onLine(side: Side, line: number): void;
}

/** The lines a gutter button takes, by side (`old`: old-side numbers, `new`: new-side ones). */
export interface GutterLines { old: ReadonlySet<number>; new: ReadonlySet<number> }

/** A line the button sits on: its side and number, and its top in the editor's box. */
export interface Hit { side: Side; line: number; top: number }

/**
 * The old line under `clientY` in an Inline/Hunk deleted-lines zone (`zoneId`, after modified line
 * `after`), and the top of its first visual line in the editor's box. Monaco draws a change's old
 * lines there, one `.view-line` per visual line (several when one wraps).
 */
export function deletedLineAt(diff: MonacoNs.editor.IDiffEditor, ed: MonacoNs.editor.ICodeEditor, zoneId: string, after: number, clientY: number): { line: number; top: number } | null {
  const root = ed.getDomNode();
  const zone = root ? [...root.querySelectorAll<HTMLElement>('.view-zones .line-delete')].find((z) => z.getAttribute('monaco-view-zone') === zoneId) : undefined;
  const change = zone ? zoneChange(diff, after) : undefined;
  const model = diff.getOriginalEditor().getModel();
  if (!root || !zone || !change || !model) return null;
  const lh = ed.getOption(monaco.editor.EditorOption.lineHeight);
  const box = zone.getBoundingClientRect();
  const lines: string[] = [];
  for (let n = change.originalStartLineNumber; n <= change.originalEndLineNumber; n++) lines.push(model.getLineContent(n));
  const segments = [...zone.querySelectorAll('.view-line')].map((s) => s.textContent ?? '');
  const at = Math.max(0, Math.min(Math.floor((clientY - box.top) / lh), Math.max(segments.length, lines.length) - 1));
  const idx = segments.length ? lineOfSegment(segments, lines, at) : Math.min(at, lines.length - 1);
  let first = at;
  while (segments.length && first > 0 && lineOfSegment(segments, lines, first - 1) === idx) first--;
  return { line: change.originalStartLineNumber + idx, top: box.top - root.getBoundingClientRect().top + first * lh };
}

/**
 * The line of `lines` under a pointer event in `ed` (the `side` editor of `diff`): one of that
 * editor's lines (its text or its margin), or, in Inline and Hunk mode, an old line in one of the
 * modified editor's deleted-lines zones. Null anywhere else.
 */
export function gutterHit(diff: MonacoNs.editor.IDiffEditor, side: Side, ed: MonacoNs.editor.ICodeEditor, e: MonacoNs.editor.IEditorMouseEvent, lines: GutterLines): Hit | null {
  const T = monaco.editor.MouseTargetType;
  const t = e.target;
  const onLine = t.type === T.GUTTER_GLYPH_MARGIN || t.type === T.GUTTER_LINE_NUMBERS || t.type === T.GUTTER_LINE_DECORATIONS || t.type === T.CONTENT_TEXT || t.type === T.CONTENT_EMPTY;
  if (onLine && t.position) {
    const n = t.position.lineNumber;
    if (!(side === 'original' ? lines.old : lines.new).has(n)) return null;
    return { side, line: n, top: ed.getTopForLineNumber(n) - ed.getScrollTop() };
  }
  if (side === 'modified' && (t.type === T.GUTTER_VIEW_ZONE || t.type === T.CONTENT_VIEW_ZONE)) {
    const d = deletedLineAt(diff, ed, t.detail.viewZoneId, t.detail.afterLineNumber, e.event.posy);
    return d && lines.old.has(d.line) ? { side: 'original', line: d.line, top: d.top } : null;
  }
  return null;
}

/**
 * The per-line button (spec #2 §7.3): a small square in the glyph margin, left of the
 * line numbers, on the changed line under the pointer: + stages that line, − unstages it. The
 * glyph margin is always there (Monaco reserves it), and the button is an overlay widget placed
 * over it, so it appears and goes without moving anything. In Inline and Hunk mode an old line
 * (a deleted-lines zone in the modified editor) gets it too.
 */
export class LineGutter {
  private spec: LineGutterSpec | null = null;
  private readonly subs: MonacoNs.IDisposable[] = [];
  private readonly hides: (() => void)[] = [];
  private readonly refreshes: (() => void)[] = [];

  private readonly diff: MonacoNs.editor.IStandaloneDiffEditor;

  constructor(diff: MonacoNs.editor.IStandaloneDiffEditor) {
    this.diff = diff;
    this.wire('original', diff.getOriginalEditor());
    this.wire('modified', diff.getModifiedEditor());
  }

  set(spec: LineGutterSpec | null): void {
    this.spec = spec;
    if (!spec) for (const h of this.hides) h();
    else for (const r of this.refreshes) r();
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
  }

  private wire(side: Side, ed: MonacoNs.editor.ICodeEditor): void {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'line-stage-glyph';
    btn.tabIndex = -1;
    btn.hidden = true;
    const mark = document.createElement('span');
    mark.setAttribute('aria-hidden', 'true');
    btn.appendChild(mark);
    let at: Hit | null = null;
    const refresh = () => {
      const s = this.spec;
      if (!s || !at) return;
      const label = s.staged ? 'Unstage this line' : 'Stage this line';
      btn.setAttribute('aria-label', label);
      btn.title = s.disabled ?? label;
      btn.classList.toggle('unstage', s.staged);
      btn.setAttribute('aria-disabled', String(s.disabled !== null));
      mark.textContent = s.staged ? '−' : '+';
    };
    const hide = () => {
      at = null;
      btn.hidden = true;
    };
    const show = (hit: Hit) => {
      const info = ed.getLayoutInfo();
      const lh = ed.getOption(monaco.editor.EditorOption.lineHeight);
      at = hit;
      Object.assign(btn.style, { top: `${hit.top}px`, left: `${info.glyphMarginLeft}px`, width: `${Math.max(info.glyphMarginWidth, 16)}px`, height: `${lh}px` });
      refresh();
      btn.hidden = false;
    };
    this.hides.push(hide);
    this.refreshes.push(refresh);
    ed.addOverlayWidget({ getId: () => `gitbolt.lineStage.${side}`, getDomNode: () => btn, getPosition: () => null });
    // The press is the button's: Monaco mustn't move the cursor or start a selection under it.
    btn.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
    btn.addEventListener('click', () => {
      const s = this.spec;
      if (s && at && s.disabled === null) s.onLine(at.side, at.line);
    });
    const T = monaco.editor.MouseTargetType;
    const locate = (e: MonacoNs.editor.IEditorMouseEvent): Hit | null => (this.spec ? gutterHit(this.diff, side, ed, e, this.spec) : null);
    this.subs.push(
      ed.onMouseMove((e) => {
        // Over the button itself: it stays.
        if (e.target.type === T.OVERLAY_WIDGET) return;
        const hit = locate(e);
        if (!hit) hide();
        else if (!at || hit.line !== at.line || hit.side !== at.side || btn.hidden) show(hit);
      }),
      ed.onMouseLeave((e) => {
        if (!(e.event.browserEvent.relatedTarget instanceof Node && btn.contains(e.event.browserEvent.relatedTarget))) hide();
      }),
      ed.onDidScrollChange(hide),
      ed.onDidChangeModel(hide),
    );
  }
}
