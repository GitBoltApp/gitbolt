import type * as MonacoNs from 'monaco-editor/editor/editor.api';
import { revealTop, stepTarget } from '../changeNav';
import type { DiffMode } from '../diffPrefs';
import { EDITOR_SCROLLBAR } from '../options';
import { monaco } from './setup';

type Side = 'original' | 'modified';
type Editor = MonacoNs.editor.ICodeEditor;
/** A view zone as Monaco's layout keeps it (`ICodeEditor.getWhitespaces`, untyped). */
interface Whitespace { id: string; afterLineNumber: number; height: number }
type LineChange = Pick<MonacoNs.editor.ILineChange, 'originalStartLineNumber' | 'originalEndLineNumber' | 'modifiedStartLineNumber' | 'modifiedEndLineNumber'>;

/** A card under a line of the shown diff (spec 2026-10-08 §2): its key, the side and line it sits
 * under (old-side numbers on `original`), a range's first line (softly highlighted; null for one
 * line), and whether Next / Previous thread stop at it. `icon`: folded (a collapsed thread): no
 * zone, but an icon in the glyph margin at the line its card would go under. */
export interface ReviewZoneItem { key: string; side: Side; line: number; startLine: number | null; stop: boolean; icon?: boolean }
/** Review mode's cards for file `path`. `placed` gets every card's node, by key, whenever the set
 * changes (and for a new `placed`): the view renders into them through portals. A folded item's
 * node is its line's icon (`ICON_CLASS`), shared by the folded items there. `expand`: an icon's
 * click, or its Enter / Space, unfolds its items. */
export interface ReviewZoneSpec { path: string; items: ReviewZoneItem[]; placed(nodes: ReadonlyMap<string, HTMLElement>): void; expand?(keys: readonly string[]): void }
/** A folded item's node: its line's icon in the glyph margin. */
export const ICON_CLASS = 'review-gutter-icon';

/** After Monaco's own zones at a line (10000: a deleted-lines block, the hidden-lines bar) and a
 * WIP diff's hunk rows (10001). */
export const REVIEW_ZONE_ORDINAL = 10002;
/** Where a card waits while its zone isn't laid out: out of the layer's sight. */
const AWAY = '-100000px';

/**
 * The editor and line a card's zone comes after, in `mode`. In Split each side has its editor. In
 * Inline and Hunk the old side's lines show inside the modified editor's deleted-lines blocks,
 * which a zone can't split: an old line's card goes under its block (after the line above the
 * change; a pure deletion's own line), or, for an old line no change took, under the line it became.
 */
export function zoneTarget(item: Pick<ReviewZoneItem, 'side' | 'line'>, mode: DiffMode, changes: readonly LineChange[]): { side: Side; after: number } {
  if (item.side === 'modified' || mode === 'split') return { side: item.side, after: item.line };
  let shift = 0;
  for (const c of changes) {
    const deletes = c.originalEndLineNumber > 0;
    if (deletes && item.line >= c.originalStartLineNumber && item.line <= c.originalEndLineNumber) {
      return { side: 'modified', after: c.modifiedEndLineNumber === 0 ? c.modifiedStartLineNumber : c.modifiedStartLineNumber - 1 };
    }
    // A pure insertion is numbered by the old line it follows.
    if ((deletes ? c.originalEndLineNumber : c.originalStartLineNumber) >= item.line) break;
    const removed = deletes ? c.originalEndLineNumber - c.originalStartLineNumber + 1 : 0;
    const added = c.modifiedEndLineNumber > 0 ? c.modifiedEndLineNumber - c.modifiedStartLineNumber + 1 : 0;
    shift += added - removed;
  }
  return { side: 'modified', after: Math.max(0, item.line + shift) };
}

/** How far to scroll so the lines in view stay put when cards change height (`from` → `to`, at
 * `top` in the scroll space): the changes of those that end above the view. */
export function shiftAbove(changes: readonly { top: number; from: number; to: number }[], scrollTop: number): number {
  return changes.reduce((sum, c) => (c.top + c.from <= scrollTop ? sum + c.to - c.from : sum), 0);
}

/** A box in the layer, in px. */
export interface Box { left: number; top: number; right: number; bottom: number }

/**
 * The layer's `clip-path`, leaving out `holes` (the find widget, sticky scroll: Monaco's overlay
 * widgets, which the layer is over): the rest of its `width` × `height` as non-overlapping
 * rectangles, row by row. '' with no hole in it.
 */
export function layerClip(width: number, height: number, holes: readonly Box[]): string {
  const hs = holes
    .map((h) => ({ left: Math.max(0, Math.floor(h.left)), top: Math.max(0, Math.floor(h.top)), right: Math.min(width, Math.ceil(h.right)), bottom: Math.min(height, Math.ceil(h.bottom)) }))
    .filter((h) => h.right > h.left && h.bottom > h.top);
  if (!hs.length) return '';
  const edges = (v: number[]) => [...new Set(v)].sort((a, b) => a - b);
  const xs = edges([0, width, ...hs.flatMap((h) => [h.left, h.right])]);
  const ys = edges([0, height, ...hs.flatMap((h) => [h.top, h.bottom])]);
  const parts: string[] = [];
  const rect = (x0: number, y0: number, x1: number, y1: number) => parts.push(`M${x0} ${y0}H${x1}V${y1}H${x0}Z`);
  for (let j = 0; j + 1 < ys.length; j++) {
    const [y0, y1] = [ys[j]!, ys[j + 1]!];
    let run: number | null = null;
    for (let i = 0; i + 1 < xs.length; i++) {
      const [x0, x1] = [xs[i]!, xs[i + 1]!];
      const [cx, cy] = [(x0 + x1) / 2, (y0 + y1) / 2];
      const open = !hs.some((h) => cx > h.left && cx < h.right && cy > h.top && cy < h.bottom);
      if (open && run === null) run = x0;
      if (!open && run !== null) {
        rect(run, y0, x0, y1);
        run = null;
      }
    }
    if (run !== null) rect(run, y0, width, y1);
  }
  // All of it covered: nothing shows (an empty path would be invalid, and clip nothing).
  return parts.length ? `path('${parts.join(' ')}')` : 'inset(50%)';
}

/** The folded items at a line: one icon in its editor's glyph margin (a glyph margin widget, so it
 * scrolls with the line and moves nothing). */
interface Icon {
  node: HTMLElement;
  side: Side;
  line: number;
  keys: string[];
  widget: MonacoNs.editor.IGlyphMarginWidget | null;
}

interface Card {
  item: ReviewZoneItem;
  /** The card's box in the layer: what the view renders into, and what's measured. */
  node: HTMLElement;
  /** Its zone: the space it takes among the lines, in `side`'s editor after line `after`. */
  side: Side;
  after: number;
  ordinal: number;
  zone: MonacoNs.editor.IViewZone | null;
  id: string | null;
  height: number;
}

/**
 * Review mode's cards (spec 2026-10-08 §2). Each takes its space among the lines as a view zone (an
 * empty spacer that reports its top), and the card itself sits in `layer`, over the editor and
 * beside it in the view's box rather than inside Monaco's element: Monaco's key handling (on its
 * container) never sees what's typed in a card, and a mode change moves only the spacer, never the
 * card, which keeps its focus and text. A zone takes its card's height as it changes; a card above
 * the view that changes height moves the view with it, so the lines being read stay put.
 */
export class ReviewZones {
  readonly layer = document.createElement('div');
  private spec: ReviewZoneSpec | null = null;
  /** The `placed` last told, so a new view (a new callback) gets the nodes even when the set is the same. */
  private told: ReviewZoneSpec['placed'] | null = null;
  private readonly cards = new Map<string, Card>();
  /** The folded items' icons, by `side:line`. */
  private readonly icons = new Map<string, Icon>();
  /** The icon under the pointer: its items' ranges show meanwhile. */
  private hovered: Icon | null = null;
  private iconSeq = 0;
  /** A press on an icon, handed to the gutter (`ReviewGutter.press`) so a drag from it picks lines
   * as one from the "+" does; `click` runs for a press that never left the line. False: no gutter. */
  pressIcon: ((side: Side, line: number, click: () => void) => boolean) | null = null;
  private path: string | null = null;
  private mode: DiffMode = 'inline';
  /** Each editor's box, relative to the layer. */
  private origins: Record<Side, { left: number; top: number }> = { original: { left: 0, top: 0 }, modified: { left: 0, top: 0 } };
  private readonly ro = new ResizeObserver((entries) => this.measured(entries.map((e) => e.target)));
  /** Monaco's overlay widgets the layer leaves out (`clip`), and their containers (new widgets). */
  private readonly watched = new WeakSet<Element>();
  private readonly mo = new MutationObserver((records) => {
    if (records.some((r) => r.type === 'childList')) this.watch();
    this.clip(this.layer.getBoundingClientRect());
  });
  private readonly ranges: Record<Side, MonacoNs.editor.IEditorDecorationsCollection>;
  /** The card the last step put the view on, and the scroll it left (`stepTarget`'s `current`). */
  private stepped: { key: string; top: number } | null = null;
  private readonly diff: MonacoNs.editor.IStandaloneDiffEditor;
  private readonly subs: MonacoNs.IDisposable[] = [];
  /** The modified editor's glyph margin before the review (`dispose` puts it back). */
  private readonly glyphMarginWas: boolean;

  constructor(diff: MonacoNs.editor.IStandaloneDiffEditor) {
    this.diff = diff;
    this.layer.className = 'review-layer';
    // Esc in a card is the card's (`repo/escape.ts`), never the diff's close.
    this.layer.dataset.ownsEscape = '';
    this.layer.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    this.ranges = { original: diff.getOriginalEditor().createDecorationsCollection(), modified: diff.getModifiedEditor().createDecorationsCollection() };
    for (const side of ['original', 'modified'] as const) this.subs.push(this.editor(side).onDidLayoutChange(() => this.placeAll()));
    // The folded threads' icons (and the "+") get a column of their own, left of the line numbers,
    // as GitLab's: Monaco's diff editor has none on the modified side (Split's old side has one).
    const m = diff.getModifiedEditor();
    this.glyphMarginWas = !!m.getOption(monaco.editor.EditorOption.glyphMargin);
    m.updateOptions({ glyphMargin: true });
  }

  /** Gone from the editor: its cards and zones, the range marks, its observers and listeners, the
   * layer. The host makes a new one for the next review (the editor is shared with every diff). */
  dispose(): void {
    this.set(null);
    for (const s of this.subs) s.dispose();
    this.subs.length = 0;
    this.ro.disconnect();
    this.mo.disconnect();
    this.ranges.original.clear();
    this.ranges.modified.clear();
    this.layer.remove();
    this.diff.getModifiedEditor().updateOptions({ glyphMargin: this.glyphMarginWas });
  }

  set(spec: ReviewZoneSpec | null): void {
    this.spec = spec;
    if (!spec) this.told = null;
    this.sync(false);
  }

  shown(path: string | null, mode: DiffMode): void {
    this.path = path;
    this.mode = mode;
    this.stepped = null;
    this.placeAll();
    this.sync(true);
  }

  relayout(): void {
    this.sync(false);
  }

  clear(): void {
    for (const c of this.cards.values()) this.unzone(c);
    for (const i of this.icons.values()) this.unglyph(i);
  }

  /** Whether `side`'s editor shows a folded thread's icon at `line` (the "+" leaves it the line). */
  iconAt(side: Side, line: number): boolean {
    return this.icons.has(`${side}:${line}`);
  }

  goTo(direction: 'next' | 'previous', margin: number): string | null {
    const m = this.diff.getModifiedEditor();
    const stops: { key: string; icon: Icon | null; box: { top: number; bottom: number } }[] = [];
    for (const c of this.cards.values()) if (c.item.stop && c.id !== null) stops.push({ key: c.item.key, icon: null, box: { top: this.zoneTop(c), bottom: this.zoneTop(c) + c.height } });
    for (const icon of this.icons.values()) {
      if (icon.widget === null) continue;
      const ed = this.editor(icon.side);
      const top = ed.getTopForLineNumber(icon.line);
      stops.push({ key: icon.keys[0]!, icon, box: { top, bottom: top + ed.getOption(monaco.editor.EditorOption.lineHeight) } });
    }
    stops.sort((a, b) => a.box.top - b.box.top);
    const height = m.getLayoutInfo().height;
    const was = this.stepped && Math.abs(m.getScrollTop() - this.stepped.top) <= 1 ? stops.findIndex((s) => s.key === this.stepped!.key) : -1;
    const i = stepTarget(stops.map((s) => s.box), { top: m.getScrollTop(), height }, direction, was >= 0 ? was : null);
    if (i === null) return null;
    const { key, icon, box } = stops[i]!;
    m.setScrollTop(revealTop(box, height, margin));
    // An icon shows once its editor draws the new view (its next frame): now, so the keyboard can
    // go to it.
    if (icon) this.editor(icon.side).render(true);
    this.stepped = { key, top: m.getScrollTop() };
    return key;
  }

  private editor(side: Side): Editor {
    return side === 'original' ? this.diff.getOriginalEditor() : this.diff.getModifiedEditor();
  }

  private sync(full: boolean): void {
    const spec = this.spec;
    const want = spec && this.path !== null && spec.path === this.path ? spec.items : [];
    const keys = new Set(want.filter((i) => !i.icon).map((i) => i.key));
    const shifts: { top: number; from: number; to: number }[] = [];
    let changed = false;
    const changes = this.diff.getLineChanges() ?? [];
    // The folded items, by the line their card would go under: an icon there.
    const folded = new Map<string, { side: Side; line: number; keys: string[] }>();
    for (const item of want) {
      if (!item.icon) continue;
      const at = zoneTarget(item, this.mode, changes);
      const line = Math.max(1, at.after);
      const id = `${at.side}:${line}`;
      const group = folded.get(id) ?? { side: at.side, line, keys: [] };
      group.keys.push(item.key);
      folded.set(id, group);
    }
    for (const [id, icon] of this.icons) {
      if (folded.has(id)) continue;
      this.unglyph(icon);
      if (this.hovered === icon) this.hovered = null;
      icon.node.remove();
      this.icons.delete(id);
      changed = true;
    }
    for (const [id, group] of folded) {
      let icon = this.icons.get(id);
      if (!icon) {
        icon = this.newIcon(group.side, group.line);
        this.icons.set(id, icon);
        changed = true;
      }
      if (icon.keys.join(' ') !== group.keys.join(' ')) changed = true;
      icon.keys = group.keys;
      if (full || icon.widget === null) {
        this.unglyph(icon);
        this.glyph(icon);
      }
    }
    for (const [key, c] of this.cards) {
      if (keys.has(key)) continue;
      if (c.id !== null) shifts.push({ top: this.zoneTop(c), from: c.height, to: 0 });
      this.unzone(c);
      this.ro.unobserve(c.node);
      c.node.remove();
      this.cards.delete(key);
      changed = true;
    }
    want.forEach((item, i) => {
      if (item.icon) return;
      let c = this.cards.get(item.key);
      if (!c) {
        const node = document.createElement('div');
        node.className = 'review-card-host';
        node.dataset.reviewKey = item.key;
        node.style.top = AWAY;
        this.layer.appendChild(node);
        this.ro.observe(node);
        c = { item, node, side: item.side, after: -1, ordinal: 0, zone: null, id: null, height: 0 };
        this.cards.set(item.key, c);
        changed = true;
      }
      c.item = item;
      const at = zoneTarget(item, this.mode, changes);
      const ordinal = REVIEW_ZONE_ORDINAL + i;
      if (full || c.id === null || c.side !== at.side || c.after !== at.after || c.ordinal !== ordinal) {
        this.unzone(c);
        this.zone(c, at.side, at.after, ordinal);
      }
    });
    this.highlight();
    this.shift(shifts);
    if (spec && (changed || spec.placed !== this.told)) {
      this.told = spec.placed;
      const nodes = new Map([...this.cards].map(([key, c]) => [key, c.node]));
      for (const icon of this.icons.values()) for (const key of icon.keys) nodes.set(key, icon.node);
      spec.placed(nodes);
    }
  }

  private zone(c: Card, side: Side, after: number, ordinal: number): void {
    const zone: MonacoNs.editor.IViewZone = {
      afterLineNumber: after,
      ordinal,
      heightInPx: c.height,
      domNode: document.createElement('div'),
      // A card on a line in Hunk's collapsed regions still shows (at the region's bar).
      showInHiddenAreas: true,
      onDomNodeTop: (top) => { c.node.style.top = `${this.origins[side].top + top}px`; },
    };
    this.editor(side).changeViewZones((acc) => { c.id = acc.addZone(zone); });
    Object.assign(c, { zone, side, after, ordinal });
    this.place(c);
  }

  /** A folded thread's icon (as GitLab's): its press is its own (Monaco would select the line), a
   * press without a drag unfolds its items, and so do Enter and Space; Esc hands the keyboard back
   * to the editor. Hovered, its items' ranges show. */
  private newIcon(side: Side, line: number): Icon {
    const node = document.createElement('div');
    node.className = ICON_CLASS;
    node.dataset.ownsEscape = '';
    node.dataset.size = String(this.editor(side).getOption(monaco.editor.EditorOption.lineHeight));
    const icon: Icon = { node, side, line, keys: [], widget: null };
    const expand = () => this.spec?.expand?.(icon.keys);
    node.addEventListener('pointerdown', (e) => e.stopPropagation());
    node.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.button === 0 && !this.pressIcon?.(side, line, expand)) expand();
    });
    node.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.key === 'Enter' || e.key === ' ') expand();
      else if (e.key === 'Escape' && !e.shiftKey) this.editor(side).focus();
      else return;
      e.preventDefault();
      e.stopPropagation();
    });
    node.addEventListener('mouseenter', () => {
      this.hovered = icon;
      this.highlight();
    });
    node.addEventListener('mouseleave', () => {
      if (this.hovered !== icon) return;
      this.hovered = null;
      this.highlight();
    });
    return icon;
  }

  private glyph(icon: Icon): void {
    const id = `gitbolt.reviewIcon.${++this.iconSeq}`;
    const range = { startLineNumber: icon.line, startColumn: 1, endLineNumber: icon.line, endColumn: 1 };
    const widget: MonacoNs.editor.IGlyphMarginWidget = {
      getId: () => id,
      getDomNode: () => icon.node,
      getPosition: () => ({ lane: monaco.editor.GlyphMarginLane.Center, zIndex: 10, range }),
    };
    this.editor(icon.side).addGlyphMarginWidget(widget);
    icon.widget = widget;
  }

  private unglyph(icon: Icon): void {
    if (icon.widget) this.editor(icon.side).removeGlyphMarginWidget(icon.widget);
    icon.widget = null;
  }

  private unzone(c: Card): void {
    const id = c.id;
    if (id !== null) this.editor(c.side).changeViewZones((acc) => acc.removeZone(id));
    c.id = null;
    c.zone = null;
    c.node.style.top = AWAY;
  }

  /** The top of a card's zone in the diff's scroll space (both editors share it): under its line
   * and the zones before it there (a deleted-lines block, the hunk row, earlier cards). */
  private zoneTop(c: Card): number {
    const ed = this.editor(c.side);
    let top = c.after <= 0 ? 0 : ed.getBottomForLineNumber(c.after);
    // Monaco's zones in its order (by view line, then ordinal); not in its typings.
    const all = (ed as Editor & { getWhitespaces?(): readonly Whitespace[] }).getWhitespaces?.() ?? [];
    const i = all.findIndex((w) => w.id === c.id);
    for (let j = i - 1; j >= 0 && all[j]!.afterLineNumber === all[i]!.afterLineNumber; j--) top += all[j]!.height;
    return top;
  }

  /** A card's left and width: its editor's text area, clear of the vertical scrollbar. */
  private place(c: Card): void {
    const info = this.editor(c.side).getLayoutInfo();
    c.node.style.left = `${this.origins[c.side].left + info.contentLeft}px`;
    c.node.style.width = `${Math.max(0, info.contentWidth - Math.max(info.verticalScrollbarWidth, EDITOR_SCROLLBAR.verticalScrollbarSize) - 4)}px`;
  }

  private placeAll(): void {
    const box = this.layer.getBoundingClientRect();
    for (const side of ['original', 'modified'] as const) {
      const r = this.editor(side).getDomNode()?.getBoundingClientRect();
      this.origins[side] = r ? { left: r.left - box.left, top: r.top - box.top } : { left: 0, top: 0 };
    }
    for (const c of this.cards.values()) this.place(c);
    this.watch();
    this.clip(box);
  }

  /** Watches each editor's overlay widgets (a new view, after a model change, has new ones): the
   * find widget coming and going, sticky scroll's height. */
  private watch(): void {
    for (const side of ['original', 'modified'] as const) {
      const root = this.editor(side).getDomNode();
      if (!root) continue;
      for (const n of root.querySelectorAll('.overlayWidgets, .find-widget, .sticky-widget')) {
        if (this.watched.has(n)) continue;
        this.watched.add(n);
        if (n.classList.contains('overlayWidgets')) this.mo.observe(n, { childList: true });
        else this.mo.observe(n, { attributes: true, attributeFilter: ['class', 'style'] });
      }
    }
  }

  /** The layer is over Monaco's element (its own stacking context): it leaves out the find widget
   * while it shows and sticky scroll's lines, which a card would otherwise cover and take clicks from. */
  private clip(layer: DOMRect): void {
    const holes: Box[] = [];
    for (const side of ['original', 'modified'] as const) {
      const root = this.editor(side).getDomNode();
      for (const n of root?.querySelectorAll<HTMLElement>('.find-widget.visible, .sticky-widget') ?? []) {
        const p = n.offsetParent;
        if (!p || n.offsetWidth === 0 || n.offsetHeight === 0) continue;
        // By offsets, not its own box: the find widget slides in (a transform) to where they put it.
        const r = p.getBoundingClientRect();
        const left = r.left - layer.left + n.offsetLeft;
        const top = r.top - layer.top + n.offsetTop;
        holes.push({ left, top, right: left + n.offsetWidth, bottom: top + n.offsetHeight });
      }
    }
    const clip = layerClip(layer.width, layer.height, holes);
    if (this.layer.style.clipPath !== clip) this.layer.style.clipPath = clip;
  }

  private measured(targets: readonly Element[]): void {
    const shifts: { top: number; from: number; to: number }[] = [];
    const drawn = new Set<Side>();
    for (const c of this.cards.values()) {
      if (!targets.includes(c.node)) continue;
      const h = c.node.offsetHeight;
      if (h === c.height) continue;
      const { zone, id } = c;
      if (zone && id !== null) {
        shifts.push({ top: this.zoneTop(c), from: c.height, to: h });
        zone.heightInPx = h;
        this.editor(c.side).changeViewZones((acc) => acc.layoutZone(id));
        drawn.add(c.side);
      }
      c.height = h;
    }
    this.shift(shifts);
    // Drawn now, before the frame paints (Monaco would wait for its next animation frame): the
    // lines under a card never show at their old place.
    for (const side of drawn) this.editor(side).render(true);
  }

  private shift(shifts: readonly { top: number; from: number; to: number }[]): void {
    const m = this.diff.getModifiedEditor();
    const by = shiftAbove(shifts, m.getScrollTop());
    if (by !== 0) m.setScrollTop(m.getScrollTop() + by);
  }

  /** A range's lines, softly highlighted where their editor draws them (Inline and Hunk: an old
   * range shows on the old line-number strip): an unfolded card's, and a hovered icon's. */
  private highlight(): void {
    const by: Record<Side, MonacoNs.editor.IModelDeltaDecoration[]> = { original: [], modified: [] };
    const hovered = new Set(this.hovered?.keys);
    const items = [...[...this.cards.values()].map((c) => c.item), ...(this.spec?.items.filter((i) => i.icon && hovered.has(i.key)) ?? [])];
    for (const item of items) {
      if (item.startLine === null || item.startLine >= item.line) continue;
      by[item.side].push({
        range: { startLineNumber: item.startLine, startColumn: 1, endLineNumber: item.line, endColumn: 1 },
        options: { isWholeLine: true, className: 'review-range', marginClassName: 'review-range' },
      });
    }
    this.ranges.original.set(by.original);
    this.ranges.modified.set(by.modified);
  }

  /** The layer is outside Monaco's element, so its wheel would scroll nothing: it scrolls the
   * diff, unless the card's own field or preview under the pointer scrolls. */
  private wheel(e: WheelEvent): void {
    const own = e.target instanceof Element ? e.target.closest<HTMLElement>('textarea, .md-field-preview') : null;
    if (own && own.scrollHeight > own.clientHeight) return;
    const m = this.diff.getModifiedEditor();
    const unit = e.deltaMode === 1 ? m.getOption(monaco.editor.EditorOption.lineHeight) : e.deltaMode === 2 ? m.getLayoutInfo().height : 1;
    e.preventDefault();
    m.setScrollTop(m.getScrollTop() + e.deltaY * unit);
  }
}
