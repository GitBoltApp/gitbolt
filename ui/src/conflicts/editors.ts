// Reached only through the lazily imported merge tool (repo/LazyDiffPanel.tsx): Monaco, Shiki
// and the editor theme stay out of the startup chunk (spec §10.3), as the diff host's do.
import type * as MonacoNs from 'monaco-editor/editor/editor.api';
import type { ConflictFilePayload } from '../api/gen/ConflictFilePayload';
import type { Pane } from '../api/gen/Pane';
import { useAppState } from '../app/state';
import { useEditorSettings } from '../diff/editorSettings';
import { clampEditorFont, EDITOR_SCROLLBAR } from '../diff/options';
import { loadMonacoHost } from '../diff/monaco/load';
import { overflowLayer } from '../diff/monaco/overflow';
import { monaco } from '../diff/monaco/setup';
import { ensureLanguage } from '../diff/monaco/shiki';
import { currentEditorTheme } from '../theme/editorThemes';
import { useTheme } from '../theme/store';
import { createCheckBox } from './checkBox';
import { createHoverTracker, regionMarks, resolveMarkColors } from './lineMarks';
import type { Span } from './mergeDrafts';
import { buildOutput, changeHits, emptyPicks, eolText, hunkState, regionText, type CheckState, type ConflictSegment, type OutRegion, type Picks, type Side } from './model';

type Editor = MonacoNs.editor.IStandaloneCodeEditor;
type Model = MonacoNs.editor.ITextModel;
export type ToggleCb = (id: number, side: Side, line: number | 'hunk') => void;

/** The output as it is now: what the merge tool keeps across a hidden tab or another file. */
export interface OutputState { text: string; spans: Span[]; edited: number[]; typed: boolean }

/** Where the editors start: the ticks, and the output as it was left (else built from them). */
export interface MergeStart { picks: Picks; output?: OutputState }

/** The merge tool's three editors (spec #2 §13.3): Current and Incoming read-only, the output
 * editable. Created on first use, disposed when the tool closes. */
export interface MergeEditors {
  output: { getValue(): string };
  /**
   * Replaces each listed region's text in the output with its lines, as one undoable edit, and
   * stops counting them as hand-edited. `before`/`after`: the ticks either side of it, so Ctrl+Z
   * (and redo) brings the ticks back with the text (`onPicksRestored`).
   */
  setRegions(list: { id: number; lines: string[] }[], before: Picks, after: Picks): void;
  /** Each region's place in the output as it is now (hand edits included). */
  regionsNow(): OutRegion[];
  /** The regions the user typed in. */
  edited(): Set<number>;
  snapshot(): OutputState;
  /** The output's cursor line (1-based). */
  cursorLine(): number;
  /** A hunk's checkbox or column (`'hunk'`), or a line's button (its index in the region), was
   * clicked in a pane. */
  onToggle(cb: ToggleCb): void;
  /** A hand edit in the output. */
  onEdit(cb: () => void): void;
  /** An undo or redo went back to a tick's text: these were the ticks then. */
  onPicksRestored(cb: (picks: Picks) => void): void;
  onCursor(cb: (line: number) => void): void;
  /** Space in a pane: ticks the pane cursor's line, when `target` is in a pane and that line is
   * a conflict's. True when it did. */
  toggleAtCursor(target: EventTarget | null): boolean;
  /** The panes' checkboxes, line buttons and tints, as `picks` says. */
  setChecks(picks: Picks): void;
  /** Brings region `id` into view in all three, with the output's cursor at its start. */
  reveal(id: number): void;
  dispose(): void;
}

/** Monaco's `ScrollType.Immediate`. */
const SCROLL_IMMEDIATE = 1;
/** The panes' line-decorations lane, which holds each conflict line's take/drop button. */
export const LINE_BUTTONS_PX = 22;
const SIDE_NAME: Record<Side, string> = { current: 'Current', incoming: 'Incoming' };

/** Options for the three editors: the diff host's fixed ones (options.ts), plus, in the panes,
 * the glyph margin (the hunk column) and a wider line-decorations lane (the line buttons). Plain
 * data, so it's unit-testable. */
export function mergeEditorOptions(readOnly: boolean, stickyScroll: boolean, fontSize: number) {
  return {
    readOnly,
    automaticLayout: false,
    renderValidationDecorations: 'off' as const,
    contextmenu: true,
    fontSize: clampEditorFont(fontSize),
    scrollbar: { ...EDITOR_SCROLLBAR },
    fixedOverflowWidgets: true,
    minimap: { enabled: true },
    renderOverviewRuler: true,
    stickyScroll: { enabled: stickyScroll },
    folding: false,
    glyphMargin: readOnly,
    ...(readOnly ? { lineDecorationsWidth: LINE_BUTTONS_PX } : {}),
    scrollBeyondLastLine: false,
    wordWrap: 'off' as const,
  };
}

/** `text` with every line break as `eol` (what Monaco's model holds). */
const normalized = (text: string, eol: string) => text.replace(/\r\n|\r|\n/g, eol);

/** The region holding pane line `line`, and the line's index in it. */
function regionAt(pane: Pane, line: number): { id: number; index: number } | null {
  const r = pane.regions.find((g) => g.lines > 0 && line >= g.start && line < g.start + g.lines);
  return r ? { id: r.id, index: line - r.start } : null;
}

export function createMergeEditors(host: { current: HTMLElement; incoming: HTMLElement; output: HTMLElement }, file: ConflictFilePayload, language: string, start?: MergeStart): MergeEditors {
  const conflicts = file.segments.filter((s): s is ConflictSegment => s.kind === 'conflict');
  const byId = new Map(conflicts.map((s) => [s.id, s]));
  const eol = eolText(file.eol);
  const panes: Record<Side, Pane> = { current: file.current ?? { text: '', regions: [] }, incoming: file.incoming ?? { text: '', regions: [] } };
  let disposed = false;
  let lastPicks: Picks = start?.picks ?? emptyPicks(file.segments);
  // Hidden until the editor theme is defined (`loadMonacoHost` resolves once it is), so no editor
  // shows in Monaco's light default for a frame.
  const els = [host.current, host.incoming, host.output];
  for (const el of els) el.style.visibility = 'hidden';
  const show = () => { if (!disposed) for (const el of els) el.style.visibility = ''; };
  void loadMonacoHost().then(show, show);

  const models: Model[] = [];
  const model = (text: string) => {
    const m = monaco.editor.createModel(text, 'plaintext');
    models.push(m);
    return m;
  };
  const make = (el: HTMLElement, m: Model, readOnly: boolean): Editor =>
    monaco.editor.create(el, {
      ...mergeEditorOptions(readOnly, useEditorSettings.getState().settings.stickyScroll, useAppState.getState().settings.editorFontSize),
      model: m,
      theme: currentEditorTheme(),
      overflowWidgetsDomNode: overflowLayer(),
    });

  const paneEd: Record<Side, Editor> = {
    current: make(host.current, model(panes.current.text), true),
    incoming: make(host.incoming, model(panes.incoming.text), true),
  };
  const built = buildOutput(file.segments, lastPicks, eol);
  const outModel = model(start?.output?.text ?? built.text);
  const out = make(host.output, outModel, false);
  // Key routing: an editable Monaco keeps its own Ctrl+Z (stage/feature.ts, undo/feature.ts).
  host.output.dataset.editable = 'true';
  const editors = [paneEd.current, paneEd.incoming, out];
  const subs: { dispose(): void }[] = [];

  void ensureLanguage(monaco, language).then((id) => {
    if (disposed || id === 'plaintext') return;
    for (const m of models) monaco.editor.setModelLanguage(m, id);
  }, () => {});

  // Layout follows each box (as the diff host's ResizeObserver does).
  const ro = new ResizeObserver(() => { for (const ed of editors) ed.layout(); });
  for (const el of els) ro.observe(el);
  const unsubs = [
    useAppState.subscribe((s, prev) => {
      if (s.settings.editorFontSize !== prev.settings.editorFontSize) for (const ed of editors) ed.updateOptions({ fontSize: clampEditorFont(s.settings.editorFontSize) });
    }),
    useEditorSettings.subscribe((s, prev) => {
      if (s.settings.stickyScroll !== prev.settings.stickyScroll) for (const ed of editors) ed.updateOptions({ stickyScroll: { enabled: s.settings.stickyScroll } });
    }),
  ];

  // --- The panes' gutter, left to right: the hunk column (the glyph margin: tinted along each
  // region, its checkbox on the region's first line), the line numbers, then each line's take (+)
  // or drop (−) button (the line-decorations lane). No inserted rows: the lines stay in place. ---
  const toggles: ToggleCb[] = [];
  const fire = (id: number, side: Side, line: number | 'hunk') => { for (const cb of toggles) cb(id, side, line); };
  const paneDecos: Record<Side, MonacoNs.editor.IEditorDecorationsCollection> = {
    current: paneEd.current.createDecorationsCollection(),
    incoming: paneEd.incoming.createDecorationsCollection(),
  };
  const heads: Record<Side, Map<number, { node: HTMLElement; set: (s: CheckState) => void }>> = { current: new Map(), incoming: new Map() };
  const LEFT = monaco.editor.GlyphMarginLane.Left;
  const takes = (id: number, side: Side) => (byId.get(id)?.[side].length ?? 0) > 0;
  for (const side of ['current', 'incoming'] as const) {
    const ed = paneEd[side];
    panes[side].regions.forEach((r, n) => {
      if (r.lines === 0 || !takes(r.id, side)) return;
      // A real checkbox (keyboard, assistive tech; `checkBox.ts`): a glyph-margin widget on the
      // first line.
      const node = document.createElement('div');
      node.className = `merge-hunk merge-hunk-${side} merge-hunk-head`;
      const box = createCheckBox(`Take conflict ${n + 1} from ${SIDE_NAME[side]}`, side, () => fire(r.id, side, 'hunk'));
      node.append(box.el);
      // Monaco's mouse handler would take the press (and capture the pointer), so the checkbox
      // never got its click: the widget keeps its presses to itself.
      for (const t of ['pointerdown', 'mousedown'] as const) node.addEventListener(t, (e) => e.stopPropagation());
      node.addEventListener('click', (e) => { if (e.target === node) box.el.click(); });
      heads[side].set(r.id, { node, set: box.set });
      const range = new monaco.Range(r.start, 1, r.start, 1);
      ed.addGlyphMarginWidget({ getId: () => `merge-hunk-${side}-${r.id}`, getDomNode: () => node, getPosition: () => ({ lane: LEFT, zIndex: 10, range }) });
    });
    // Monaco hides its margin from assistive tech; the hunk checkboxes there are real controls, so
    // the glyph-margin widgets' layer is exposed (the line numbers' own layer stays hidden).
    const dom = ed.getDomNode();
    for (let el = dom?.querySelector('.glyph-margin-widgets')?.parentElement ?? null; el && el !== dom; el = el.parentElement) el.removeAttribute('aria-hidden');
    subs.push(ed.onMouseDown((e) => {
      const t = e.target.type;
      const column = t === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN;
      if ((!column && t !== monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS) || !e.target.position) return;
      const at = regionAt(panes[side], e.target.position.lineNumber);
      if (!at) return;
      // The tinted column takes the whole hunk; a line's button, that line.
      if (!column) fire(at.id, side, at.index);
      else if (takes(at.id, side)) fire(at.id, side, 'hunk');
    }));
  }

  // The line button shows only under the pointer: the hovered line gets a `hover` class.
  let marks = resolveMarkColors();
  const hovered: Record<Side, number | null> = { current: null, incoming: null };
  const T = monaco.editor.MouseTargetType;
  const overLine = [T.CONTENT_TEXT, T.CONTENT_EMPTY, T.GUTTER_LINE_NUMBERS, T.GUTTER_LINE_DECORATIONS, T.GUTTER_GLYPH_MARGIN];
  for (const side of ['current', 'incoming'] as const) {
    const tracker = createHoverTracker((line) => { hovered[side] = line; paintPanes(); });
    subs.push(paneEd[side].onMouseMove((e) => tracker.move(overLine.includes(e.target.type) ? e.target.position?.lineNumber : null)));
    subs.push(paneEd[side].onMouseLeave(() => tracker.leave()));
  }

  const HUNK_CLASS: Record<string, string> = { all: ' on', some: ' some', none: '' };
  function paintPanes() {
    for (const side of ['current', 'incoming'] as const) {
      const decos: MonacoNs.editor.IModelDeltaDecoration[] = [];
      const lineCount = paneEd[side].getModel()?.getLineCount() ?? 1;
      for (const r of panes[side].regions) {
        const seg = byId.get(r.id);
        if (r.lines === 0) {
          // Nothing on this side: a rule where its lines would go.
          const below = r.start > 1;
          const n = Math.min(lineCount, below ? r.start - 1 : 1);
          decos.push({ range: new monaco.Range(n, 1, n, 1), options: { isWholeLine: true, className: `merge-pane-gap-${below ? 'below' : 'above'} merge-pane-gap-${side}`, ...regionMarks(marks, side) } });
          continue;
        }
        const flags = lastPicks[r.id]?.[side] ?? [];
        const state = seg && lastPicks[r.id] ? hunkState(seg, lastPicks[r.id], side) : 'none';
        const hunk = `merge-hunk merge-hunk-${side}${HUNK_CLASS[state]}`;
        for (let i = 0; i < r.lines; i++) {
          const on = !!flags[i];
          decos.push({
            range: new monaco.Range(r.start + i, 1, r.start + i, 1),
            options: {
              isWholeLine: true,
              className: `merge-${side}-line${on ? ' picked' : ''}`,
              glyphMarginClassName: hunk,
              glyphMargin: { position: LEFT },
              linesDecorationsClassName: `merge-line-btn ${on ? 'drop' : 'take'}${hovered[side] === r.start + i ? ' hover' : ''}`,
              ...regionMarks(marks, side),
            },
          });
        }
        const head = heads[side].get(r.id);
        if (head) {
          head.node.className = `${hunk} merge-hunk-head`;
          head.set(state);
        }
      }
      paneDecos[side].set(decos);
    }
  }

  // --- The output: one tracked range per region, its tints, and the hand edits ---
  // M1: the end edge doesn't grow, so typing at column 1 of the line after a region stays out.
  const stick = { stickiness: monaco.editor.TrackedRangeStickiness.GrowsOnlyWhenTypingBefore };
  let tracked = new Map<number, string>();
  const setSpans = (spans: Span[]) => {
    const old = [...tracked.values()];
    const ids = outModel.deltaDecorations(old, spans.map((s) => ({ range: monaco.Range.fromPositions(outModel.getPositionAt(s.from), outModel.getPositionAt(s.to)), options: stick })));
    tracked = new Map(spans.map((s, i) => [s.id, ids[i]]));
  };
  const spansNow = (): Span[] =>
    [...tracked.entries()].flatMap(([id, d]) => {
      const r = outModel.getDecorationRange(d);
      return r ? [{ id, from: outModel.getOffsetAt(r.getStartPosition()), to: outModel.getOffsetAt(r.getEndPosition()) }] : [];
    }).sort((a, b) => a.from - b.from);
  {
    const lines = outModel.getLinesContent();
    const offsetOf = (line: number) => lines.slice(0, line - 1).reduce((n, l) => n + l.length + outModel.getEOL().length, 0);
    setSpans(start?.output?.spans ?? built.regions.map((r) => {
      const from = Math.min(offsetOf(r.start), outModel.getValueLength());
      const len = normalized(regionText(regionLinesOf(r.id), eol), outModel.getEOL()).length;
      return { id: r.id, from, to: from + len };
    }));
  }
  function regionLinesOf(id: number): string[] {
    const seg = byId.get(id);
    const p = lastPicks[id];
    if (!seg || !p) return [];
    return [...seg.current.filter((_, i) => p.current[i]), ...seg.incoming.filter((_, i) => p.incoming[i])];
  }
  const edited = new Set<number>(start?.output?.edited ?? []);
  let typed = start?.output?.typed ?? false;
  const tints = out.createDecorationsCollection();
  let ours = false;
  let lastSpans = spansNow();
  // N5: the output's length, and whether it ends without a line break, as of the last change: a
  // region that ends the file on an unterminated line takes typing at its end.
  let lastLen = outModel.getValueLength();
  let lastOpenEnd = outModel.getLineContent(outModel.getLineCount()) !== '';
  const remember = (spans: Span[]) => {
    lastSpans = spans;
    lastLen = outModel.getValueLength();
    lastOpenEnd = outModel.getLineContent(outModel.getLineCount()) !== '';
  };

  const regionsNow = (): OutRegion[] =>
    [...tracked.keys()].flatMap((id) => {
      const d = tracked.get(id);
      const r = d ? outModel.getDecorationRange(d) : null;
      if (!r) return [];
      const lines = r.isEmpty() ? 0 : r.endLineNumber - r.startLineNumber + (r.endColumn > 1 ? 1 : 0);
      return [{ id, start: r.startLineNumber, lines }];
    });
  /** M4: each line tinted by the side it came from; a hand-edited region in the base colour. */
  const paintOutput = () => {
    const decos: MonacoNs.editor.IModelDeltaDecoration[] = [];
    for (const r of regionsNow()) {
      const p = lastPicks[r.id];
      // Unresolved until a line is taken (or the user types in it).
      const m = regionMarks(marks, edited.has(r.id) || (p && (p.current.some(Boolean) || p.incoming.some(Boolean))) ? 'resolved' : 'unresolved');
      const line = (n: number, className: string) => decos.push({ range: new monaco.Range(n, 1, n, 1), options: { isWholeLine: true, className, ...m } });
      if (r.lines === 0) {
        // An empty region shows as a rule where its lines would go.
        if (r.start > 1) line(r.start - 1, 'merge-output-gap-below');
        else line(1, 'merge-output-gap-above');
        continue;
      }
      const cur = p ? p.current.filter(Boolean).length : 0;
      const exact = !edited.has(r.id) && p && r.lines === cur + p.incoming.filter(Boolean).length;
      for (let i = 0; i < r.lines; i++) line(r.start + i, !exact ? 'merge-output-edited' : i < cur ? 'merge-output-current' : 'merge-output-incoming');
    }
    tints.set(decos);
  };
  // The marks' colours follow the app theme (the tokens apply after the store changes).
  unsubs.push(useTheme.subscribe(() => requestAnimationFrame(() => { if (disposed) return; marks = resolveMarkColors(); paintPanes(); paintOutput(); })));
  const setChecks = (picks: Picks) => {
    lastPicks = picks;
    paintPanes();
    paintOutput();
  };
  setChecks(lastPicks);

  // M8: the ticks (and region places) each tick left, by the output's version, for Ctrl+Z.
  const history = new Map<number, { picks: Picks; spans: Span[]; edited: number[] }>();
  const edits: Array<() => void> = [];
  const restored: Array<(p: Picks) => void> = [];
  subs.push(outModel.onDidChangeContent((e) => {
    if (!ours) {
      const back = (e.isUndoing || e.isRedoing) ? history.get(outModel.getAlternativeVersionId()) : undefined;
      if (back) {
        setSpans(back.spans);
        lastPicks = back.picks;
        edited.clear();
        for (const id of back.edited) edited.add(id);
        for (const cb of restored) cb(back.picks);
      } else {
        typed = true;
        for (const c of e.changes) {
          for (const s of lastSpans) {
            const openEnd = s.from < s.to && s.to === lastLen && lastOpenEnd;
            if (!changeHits(c.rangeOffset, c.rangeLength, c.text, s.from, s.to, openEnd)) continue;
            edited.add(s.id);
            // Typing into an empty region, or at the end of one that ends the file unterminated,
            // extends it (those edges don't grow by themselves).
            const fills = (s.from === s.to && c.rangeOffset === s.from) || (openEnd && c.rangeOffset === s.to);
            if (fills && e.changes.length === 1) {
              const rest = spansNow().filter((x) => x.id !== s.id);
              setSpans([...rest, { id: s.id, from: s.from, to: s.to + normalized(c.text, outModel.getEOL()).length }].sort((a, b) => a.from - b.from));
            }
          }
        }
        for (const cb of edits) cb();
      }
    }
    remember(spansNow());
    paintOutput();
  }));

  const setRegions = (list: { id: number; lines: string[] }[], before: Picks, after: Picks) => {
    if (list.length === 0) return;
    const now = spansNow();
    const text = new Map(list.map((x) => [x.id, normalized(regionText(x.lines, eol), outModel.getEOL())]));
    const ops: MonacoNs.editor.IIdentifiedSingleEditOperation[] = [];
    const next: Span[] = [];
    let delta = 0;
    for (const s of now) {
      const t = text.get(s.id);
      const from = s.from + delta;
      if (t === undefined) {
        next.push({ id: s.id, from, to: s.to + delta });
        continue;
      }
      ops.push({ range: monaco.Range.fromPositions(outModel.getPositionAt(s.from), outModel.getPositionAt(s.to)), text: t, forceMoveMarkers: false });
      next.push({ id: s.id, from, to: from + t.length });
      delta += t.length - (s.to - s.from);
    }
    const v = outModel.getAlternativeVersionId();
    if (!history.has(v)) history.set(v, { picks: before, spans: now, edited: [...edited] });
    ours = true;
    try {
      out.pushUndoStop();
      out.executeEdits('merge-tool', ops);
      out.pushUndoStop();
    } finally {
      ours = false;
    }
    setSpans(next);
    remember(next);
    for (const x of list) edited.delete(x.id);
    lastPicks = after;
    history.set(outModel.getAlternativeVersionId(), { picks: after, spans: next, edited: [...edited] });
    paintOutput();
  };

  // --- Sync scroll: the same fraction of each editor's scroll range ---
  let syncing = false;
  const scrollRange = (ed: Editor) => Math.max(0, ed.getScrollHeight() - ed.getLayoutInfo().height);
  for (const ed of editors) {
    subs.push(ed.onDidScrollChange((e) => {
      if (syncing || !e.scrollTopChanged) return;
      const max = scrollRange(ed);
      const f = max > 0 ? ed.getScrollTop() / max : 0;
      syncing = true;
      try {
        for (const o of editors) if (o !== ed) o.setScrollTop(f * scrollRange(o), SCROLL_IMMEDIATE);
      } finally {
        syncing = false;
      }
    }));
  }

  const reveal = (id: number) => {
    syncing = true;
    try {
      for (const side of ['current', 'incoming'] as const) {
        const r = panes[side].regions.find((g) => g.id === id);
        if (r) paneEd[side].revealLineInCenter(Math.max(1, r.start), SCROLL_IMMEDIATE);
      }
      const d = tracked.get(id);
      const r = d ? outModel.getDecorationRange(d) : null;
      if (r) {
        out.setPosition(r.getStartPosition());
        out.revealLineInCenter(r.startLineNumber, SCROLL_IMMEDIATE);
        out.focus();
      }
    } finally {
      syncing = false;
    }
  };

  const cursors: Array<(line: number) => void> = [];
  subs.push(out.onDidChangeCursorPosition((e) => { for (const cb of cursors) cb(e.position.lineNumber); }));

  return {
    output: { getValue: () => outModel.getValue() },
    setRegions,
    regionsNow,
    edited: () => new Set(edited),
    snapshot: () => ({ text: outModel.getValue(), spans: spansNow(), edited: [...edited], typed }),
    cursorLine: () => out.getPosition()?.lineNumber ?? 1,
    onToggle: (cb) => void toggles.push(cb),
    onEdit: (cb) => void edits.push(cb),
    onPicksRestored: (cb) => void restored.push(cb),
    onCursor: (cb) => void cursors.push(cb),
    toggleAtCursor: (target) => {
      const el = target instanceof Node ? target : null;
      for (const side of ['current', 'incoming'] as const) {
        if (!el || !paneEd[side].getContainerDomNode().contains(el)) continue;
        // A hunk's checkbox has the focus: Space is its own (a button's click).
        if (el instanceof Element && el.closest('.merge-check')) return false;
        const at = regionAt(panes[side], paneEd[side].getPosition()?.lineNumber ?? 0);
        if (!at) return false;
        fire(at.id, side, at.index);
        return true;
      }
      return false;
    },
    setChecks,
    reveal,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      ro.disconnect();
      for (const u of unsubs) u();
      for (const s of subs) s.dispose();
      for (const ed of editors) ed.dispose();
      for (const m of models) m.dispose();
      delete host.output.dataset.editable;
    },
  };
}
