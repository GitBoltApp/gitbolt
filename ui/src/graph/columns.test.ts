import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { allocateColumns, autoGraphWidth, columnMax, columnPrefsPersistence, COLUMN_MIN, DEFAULT_COLUMN_PREFS, SHA_W, useColumnPrefs, type ColumnWidths, type ResizableColumn } from './columns';

// labels 200, graph 64, author 160, date 170, sha 72: everything but Message sums to 666.
const prefs = { labels: 200, graph: 64, author: 160, date: 170 };
const fixed = prefs.labels + prefs.graph + prefs.author + prefs.date + SHA_W;
const sum = (w: ColumnWidths) => w.labels + w.graph + w.message + w.author + w.date + w.sha;

describe('allocateColumns', () => {
  it('gives Message all the space left over once it is at or above its minimum', () => {
    const w = allocateColumns(prefs, 1400);
    expect(w).toEqual({ labels: 200, graph: 64, message: 1400 - fixed, author: 160, date: 170, sha: SHA_W, total: 1400 });
    // Widening only ever grows Message.
    const wider = allocateColumns(prefs, 1600);
    expect(wider.message - w.message).toBe(200);
    expect({ ...wider, message: 0, total: 0 }).toEqual({ ...w, message: 0, total: 0 });
  });

  it('shrinks Message first, down to exactly its minimum, before touching anything else', () => {
    const w = allocateColumns(prefs, fixed + COLUMN_MIN.message);
    expect(w.message).toBe(COLUMN_MIN.message);
    expect(w.author).toBe(160);
    expect(w.date).toBe(170);
    expect(w.total).toBe(fixed + COLUMN_MIN.message);
  });

  it('then shrinks Author and Date in proportion to their room above their minimums', () => {
    // 36 px short of fitting everything at preference. Author has 100 px of room (160 - 60),
    // Date 80 (170 - 90): they give up 20 and 16.
    const available = fixed + COLUMN_MIN.message - 36;
    const w = allocateColumns(prefs, available);
    expect(w.message).toBe(COLUMN_MIN.message);
    expect(w.author).toBe(140);
    expect(w.date).toBe(154);
    expect(w.labels).toBe(200);
    expect(w.graph).toBe(64);
    expect(w.total).toBe(available);
    expect(sum(w)).toBe(available);
  });

  it('keeps whole-pixel widths that still add up exactly when the proportion is fractional', () => {
    const available = fixed + COLUMN_MIN.message - 25;
    const w = allocateColumns(prefs, available);
    expect(Number.isInteger(w.author) && Number.isInteger(w.date)).toBe(true);
    expect(w.author + w.date).toBe(160 + 170 - 25);
    expect(sum(w)).toBe(available);
  });

  it('floors every column at its minimum and overflows (the table scrolls) below the sum of minimums', () => {
    const w = allocateColumns(prefs, 300);
    expect(w).toEqual({ labels: 200, graph: 64, message: COLUMN_MIN.message, author: COLUMN_MIN.author, date: COLUMN_MIN.date, sha: SHA_W, total: 200 + 64 + COLUMN_MIN.message + COLUMN_MIN.author + COLUMN_MIN.date + SHA_W });
    expect(w.total).toBeGreaterThan(300);
    expect(allocateColumns(prefs, 0)).toEqual(w);
  });

  it('never lets a preference below a minimum through', () => {
    const w = allocateColumns({ labels: 10, graph: 10, author: 10, date: 10 }, 2000);
    expect([w.labels, w.graph, w.author, w.date]).toEqual([COLUMN_MIN.labels, COLUMN_MIN.graph, COLUMN_MIN.author, COLUMN_MIN.date]);
    expect(sum(w)).toBe(2000);
  });

  it('leaves Branch/Tag and Graph at their preferred widths no matter how narrow the window gets', () => {
    for (const available of [2000, 900, 700, 400]) {
      const w = allocateColumns({ ...prefs, labels: 260, graph: 120 }, available);
      expect([w.labels, w.graph]).toEqual([260, 120]);
    }
  });
});

describe('autoGraphWidth', () => {
  it('fits every lane plus padding, at least 64 px and with no upper cap (no lane is ever clipped)', () => {
    expect(autoGraphWidth(1, { laneW: 16, padX: 8 })).toBe(64);
    expect(autoGraphWidth(10, { laneW: 16, padX: 8 })).toBe(176);
    expect(autoGraphWidth(40, { laneW: 16, padX: 8 })).toBe(656);
    expect(autoGraphWidth(100, { laneW: 16, padX: 8 })).toBe(1616);
  });
});

describe('useColumnPrefs', () => {
  beforeEach(() => useColumnPrefs.getState().reset());

  it('starts from the defaults, with an automatic graph width', () => {
    expect(useColumnPrefs.getState().prefs).toEqual(DEFAULT_COLUMN_PREFS);
    expect(DEFAULT_COLUMN_PREFS.graph).toBeNull();
  });

  it('clamps set widths to the column minimum and rounds them to whole pixels', () => {
    const { setWidth } = useColumnPrefs.getState();
    setWidth('labels', 20);
    setWidth('graph', 99.6);
    setWidth('author', 59);
    setWidth('date', 300);
    expect(useColumnPrefs.getState().prefs).toEqual({ labels: COLUMN_MIN.labels, graph: 100, author: COLUMN_MIN.author, date: 300 });
  });
});

// Gesture helpers. `dx` is how far the dragged boundary moves, in px (positive = right).
const GRAPH = 64;
const rendered = (avail: number) => {
  const p = useColumnPrefs.getState().prefs;
  return allocateColumns({ ...p, graph: p.graph ?? GRAPH }, avail);
};
/** Left x of every boundary a handle sits on. */
const edges = (w: ColumnWidths) => ({
  labels: w.labels,
  graph: w.labels + w.graph,
  author: w.labels + w.graph + w.message,
  date: w.labels + w.graph + w.message + w.author,
});
/** One key press, as ColumnResizer does it. */
const press = (col: ResizableColumn, dx: number, avail: number) => {
  const s = useColumnPrefs.getState();
  s.beginResize(col, rendered(avail), avail);
  s.resizeBy(dx);
  s.endResize();
};
/** A pointer drag in 1 px steps to `to`; calls `each(d, widths)` after every step. */
const drag = (col: ResizableColumn, to: number, avail: number, each: (d: number, w: ColumnWidths) => void) => {
  const s = useColumnPrefs.getState();
  s.beginResize(col, rendered(avail), avail);
  const dir = Math.sign(to);
  for (let d = dir; Math.abs(d) <= Math.abs(to); d += dir) {
    useColumnPrefs.getState().resizeBy(d);
    each(d, rendered(avail));
  }
  useColumnPrefs.getState().endResize();
};

describe('resizing Author/Date while the smart fit is squeezing them (790 px)', () => {
  // Default prefs, 64 px graph, 790 px: Message at its 160 minimum, Author 140 (pref 160),
  // Date 154 (pref 170). The boundary under the pointer is the one that moves: Message is a wall.
  const AVAIL = 790;
  beforeEach(() => useColumnPrefs.getState().reset());

  it('precondition: both columns are squeezed below their preferences', () => {
    expect(rendered(AVAIL)).toMatchObject({ message: COLUMN_MIN.message, author: 140, date: 154 });
  });

  it('Author: widening hits the Message wall (nothing moves, and nothing is adopted)', () => {
    press('author', -8, AVAIL);
    expect(rendered(AVAIL)).toMatchObject({ message: 160, author: 140, date: 154 });
    expect(useColumnPrefs.getState().prefs).toEqual(DEFAULT_COLUMN_PREFS);
    drag('author', -30, AVAIL, (d, w) => expect(w.author, `d=${d}`).toBe(140));
    expect(useColumnPrefs.getState().prefs).toEqual(DEFAULT_COLUMN_PREFS);
  });

  it('Author: narrowing moves its handle exactly with the gesture and gives the space to Message', () => {
    const start = rendered(AVAIL);
    drag('author', 50, AVAIL, (d, w) => {
      expect(edges(w).author, `d=${d}`).toBe(edges(start).author + d);
      expect(w.author).toBe(start.author - d);
      expect(w.date).toBe(start.date);
      expect(w.message).toBe(start.message + d);
    });
  });

  it('Date: widening takes width 1:1 from Author until Author is at its minimum, handle under the pointer', () => {
    const start = rendered(AVAIL);
    const room = start.author - COLUMN_MIN.author; // 80
    drag('date', -120, AVAIL, (d, w) => {
      const moved = Math.min(-d, room);
      expect(edges(w).date, `d=${d}`).toBe(edges(start).date - moved);
      expect(w.date).toBe(start.date + moved);
      expect(w.author).toBe(start.author - moved);
      expect(w.message).toBe(COLUMN_MIN.message);
    });
  });

  it('Date: key presses step exactly 8 each way', () => {
    let prev = rendered(AVAIL);
    for (let i = 0; i < 3; i++) {
      press('date', -8, AVAIL);
      const now = rendered(AVAIL);
      expect([now.date, now.author, edges(now).date]).toEqual([prev.date + 8, prev.author - 8, edges(prev).date - 8]);
      prev = now;
    }
    press('date', +8, AVAIL);
    const now = rendered(AVAIL);
    expect([now.date, now.author, now.message]).toEqual([prev.date - 8, prev.author, prev.message + 8]);
  });

  it('leaves no preference above what is rendered, so widening the window afterwards does not jump', () => {
    press('date', -8, AVAIL);
    const after = rendered(AVAIL);
    const { prefs } = useColumnPrefs.getState();
    expect([prefs.author, prefs.date]).toEqual([after.author, after.date]);
    const wide = rendered(1400);
    expect([wide.author, wide.date]).toEqual([after.author, after.date]);
  });

  it('a stray click (no movement) or a drag back to where it started adopts nothing it has not moved', () => {
    const s = useColumnPrefs.getState();
    s.beginResize('date', rendered(AVAIL), AVAIL);
    s.resizeBy(0);
    s.endResize();
    expect(useColumnPrefs.getState().prefs).toEqual(DEFAULT_COLUMN_PREFS);
    // Moving and coming back restores the start widths exactly.
    const start = rendered(AVAIL);
    s.beginResize('date', start, AVAIL);
    useColumnPrefs.getState().resizeBy(-10);
    useColumnPrefs.getState().resizeBy(0);
    useColumnPrefs.getState().endResize();
    expect(rendered(AVAIL)).toEqual(start);
  });
});

describe('resizing Author/Date with room to spare (1400 px)', () => {
  const AVAIL = 1400;
  beforeEach(() => useColumnPrefs.getState().reset());

  it('Author widens 1:1 out of Message, then stops at the Message wall', () => {
    const start = rendered(AVAIL);
    drag('author', -(start.message - COLUMN_MIN.message + 40), AVAIL, (d, w) => {
      const moved = Math.min(-d, start.message - COLUMN_MIN.message);
      expect(edges(w).author, `d=${d}`).toBe(edges(start).author - moved);
      expect(w.author).toBe(start.author + moved);
    });
  });

  it('Date widens out of Message first, then out of Author, then stops', () => {
    const start = rendered(AVAIL);
    const room = start.message - COLUMN_MIN.message + start.author - COLUMN_MIN.author;
    drag('date', -(room + 30), AVAIL, (d, w) => {
      const moved = Math.min(-d, room);
      expect(edges(w).date, `d=${d}`).toBe(edges(start).date - moved);
      expect(w.date).toBe(start.date + moved);
    });
    expect(rendered(AVAIL)).toMatchObject({ message: COLUMN_MIN.message, author: COLUMN_MIN.author });
  });
});

describe('resizing Branch/Tag and Graph wider than columnMax allows (narrow window)', () => {
  const AVAIL = 1000;
  beforeEach(() => useColumnPrefs.getState().reset());

  for (const [col, wide] of [['labels', 700], ['graph', 600]] as const) {
    it(`${col} at ${wide}: a widening gesture never shrinks it, a narrowing one tracks the pointer`, () => {
      useColumnPrefs.getState().setWidth(col, wide); // e.g. widened in a 1600 px window, then the window shrank
      expect(wide).toBeGreaterThan(columnMax(col, AVAIL));
      press(col, +8, AVAIL);
      expect(rendered(AVAIL)[col]).toBe(wide);
      drag(col, 20, AVAIL, (d, w) => expect(w[col], `d=${d}`).toBe(wide));
      drag(col, -20, AVAIL, (d, w) => expect(w[col], `d=${d}`).toBe(wide + d));
      press(col, -8, AVAIL);
      expect(rendered(AVAIL)[col]).toBe(wide - 28);
    });

    it(`${col}: still capped at columnMax when it starts below it`, () => {
      press(col, +5000, AVAIL);
      expect(rendered(AVAIL)[col]).toBe(columnMax(col, AVAIL));
    });
  }
});

describe('column prefs persistence seam', () => {
  beforeEach(() => useColumnPrefs.getState().reset());
  afterEach(() => vi.restoreAllMocks());

  it('loads per repo, and saves once per gesture that changed something, keyed by the repo', () => {
    const load = vi.spyOn(columnPrefsPersistence, 'load').mockImplementation((id) => (id === '/repo/b' ? { ...DEFAULT_COLUMN_PREFS, labels: 300 } : null));
    const save = vi.spyOn(columnPrefsPersistence, 'save');
    const s = useColumnPrefs.getState();
    s.loadFor('/repo/a');
    expect(load).toHaveBeenLastCalledWith('/repo/a');
    expect(useColumnPrefs.getState().prefs).toEqual(DEFAULT_COLUMN_PREFS);

    s.beginResize('labels', rendered(1400), 1400);
    for (let d = 1; d <= 10; d++) useColumnPrefs.getState().resizeBy(d);
    expect(save).not.toHaveBeenCalled();
    useColumnPrefs.getState().endResize();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenLastCalledWith('/repo/a', { ...DEFAULT_COLUMN_PREFS, labels: 210 });

    // A gesture that moves nothing saves nothing.
    s.beginResize('labels', rendered(1400), 1400);
    useColumnPrefs.getState().resizeBy(0);
    useColumnPrefs.getState().endResize();
    expect(save).toHaveBeenCalledTimes(1);

    useColumnPrefs.getState().loadFor('/repo/b');
    expect(useColumnPrefs.getState().prefs.labels).toBe(300);

    // Re-loading the repo already shown keeps the session's widths instead of re-reading them.
    useColumnPrefs.getState().setWidth('labels', 320);
    useColumnPrefs.getState().loadFor('/repo/b');
    expect(useColumnPrefs.getState().prefs.labels).toBe(320);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
