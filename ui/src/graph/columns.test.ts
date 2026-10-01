import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { allocateColumns, autoGraphWidth, columnMax, handleRange, handleShown, hiddenColumnsPersistence, isCollapsed, lanesWidth, SHA_MAX, columnPrefsPersistence, COLUMN_MIN, DEFAULT_COLUMN_PREFS, SHA_W, useColumnPrefs, type ColumnWidths, type ResizableColumn } from './columns';

// labels 200, graph 64, author 160, date 170, sha SHA_W: everything but Message sums to 594 + SHA_W.
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
    setWidth('sha', 9000);
    expect(useColumnPrefs.getState().prefs).toEqual({ labels: COLUMN_MIN.labels, graph: 100, author: COLUMN_MIN.author, date: 300, sha: SHA_MAX });
    setWidth('sha', 1);
    expect(useColumnPrefs.getState().prefs.sha).toBe(COLUMN_MIN.sha);
  });
});

// Gesture helpers. `dx` is how far the dragged boundary moves, in px (positive = right).
const GRAPH = 64;
const rendered = (avail: number) => {
  const p = useColumnPrefs.getState().prefs;
  return allocateColumns({ ...p, graph: p.graph ?? GRAPH }, avail);
};
/** Right x of every column: each handle sits on the right edge of the column it's named after. */
const edges = (w: ColumnWidths) => ({
  labels: w.labels,
  graph: w.labels + w.graph,
  message: w.labels + w.graph + w.message,
  author: w.labels + w.graph + w.message + w.author,
  date: w.labels + w.graph + w.message + w.author + w.date,
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
  if (dir === 0) throw new Error('drag: zero-length drag');
  for (let d = dir; Math.abs(d) <= Math.abs(to); d += dir) {
    useColumnPrefs.getState().resizeBy(d);
    each(d, rendered(avail));
  }
  useColumnPrefs.getState().endResize();
};

describe('every handle is its column\'s right edge, and resizes that column (F3)', () => {
  // The handle under the pointer moves 1:1, and it trades width only with the column on its
  // right: Branch/Tag and Graph with the flexing Message; Message with Author; Author with Date;
  // Date with SHA. SHA is last: its right edge is the table's end, with no handle.
  beforeEach(() => useColumnPrefs.getState().reset());
  const giver = { labels: 'message', graph: 'message', message: 'author', author: 'date', date: 'sha' } as const;
  const cols: ResizableColumn[] = ['labels', 'graph', 'message', 'author', 'date'];

  // At 778 px Message is at its minimum, so Branch/Tag and Graph grow by the smart fit squeezing
  // Author and Date (1A, covered by allocateColumns); Message's and Author's handles still trade.
  for (const [avail, which] of [[1400, cols], [778, ['message', 'author', 'date']]] as const) {
    for (const col of which) {
      it(`${avail} px: dragging ${col}'s right edge right, then left, resizes ${col} with the pointer`, () => {
        const start = rendered(avail);
        const room = start[giver[col]] - COLUMN_MIN[giver[col]];
        const steps = Math.min(20, room);
        // Date's giver, SHA, starts at its minimum (H15): rightward is a wall, so only left.
        if (steps > 0) drag(col, steps, avail, (d, w) => {
          expect(edges(w)[col], `${col} edge d=${d}`).toBe(edges(start)[col] + d);
          expect(w[col], `${col} width d=${d}`).toBe(start[col] + d);
          expect(w[giver[col]]).toBe(start[giver[col]] - d);
          expect(w.total).toBe(start.total);
        });
        const mid = rendered(avail);
        drag(col, -10, avail, (d, w) => {
          expect(edges(w)[col], `${col} edge d=${d}`).toBe(edges(mid)[col] + d);
          expect(w[col]).toBe(mid[col] + d);
        });
      });
    }
  }

  it('the old F3 bug: Author\'s right edge resizes Author (and Date), never Message', () => {
    const start = rendered(1400);
    drag('author', 30, 1400, () => {});
    const w = rendered(1400);
    expect([w.author, w.date, w.message]).toEqual([start.author + 30, start.date - 30, start.message]);
    drag('author', -50, 1400, () => {});
    const back = rendered(1400);
    expect([back.author, back.date, back.message]).toEqual([start.author - 20, start.date + 20, start.message]);
  });

  it('walls: the giving column stops at its minimum, and so does the dragged one', () => {
    const start = rendered(1400);
    drag('author', start.date - COLUMN_MIN.date + 40, 1400, () => {});
    expect(rendered(1400)).toMatchObject({ date: COLUMN_MIN.date, message: start.message });
    drag('author', -2000, 1400, () => {});
    expect(rendered(1400).author).toBe(COLUMN_MIN.author);
    useColumnPrefs.getState().reset();
    drag('message', -2000, 1400, () => {});
    expect(rendered(1400)).toMatchObject({ message: COLUMN_MIN.message, date: start.date });
  });

  describe('while the smart fit squeezes Author and Date (778 px)', () => {
    // Default prefs, 64 px graph, 778 px (SHA at its 60 px default): Message at its 160 minimum, Author 140 (pref 160),
    // Date 154 (pref 170).
    const AVAIL = 778;

    it('precondition: both columns are squeezed below their preferences', () => {
      expect(rendered(AVAIL)).toMatchObject({ message: COLUMN_MIN.message, author: 140, date: 154 });
    });

    it('Message is a wall: narrowing it (its right edge left) moves nothing, and adopts nothing', () => {
      press('message', -8, AVAIL);
      expect(rendered(AVAIL)).toMatchObject({ message: 160, author: 140, date: 154 });
      expect(useColumnPrefs.getState().prefs).toEqual(DEFAULT_COLUMN_PREFS);
      drag('message', -30, AVAIL, (d, w) => expect(w.message, `d=${d}`).toBe(160));
      expect(useColumnPrefs.getState().prefs).toEqual(DEFAULT_COLUMN_PREFS);
    });

    it('Author: key presses step exactly 8 each way, trading with Date', () => {
      let prev = rendered(AVAIL);
      for (const dx of [8, 8, -8]) {
        press('author', dx, AVAIL);
        const now = rendered(AVAIL);
        expect([now.author, now.date, now.message, edges(now).author]).toEqual([prev.author + dx, prev.date - dx, prev.message, edges(prev).author + dx]);
        prev = now;
      }
    });

    it('leaves no preference above what is rendered, so widening the window afterwards does not jump', () => {
      press('author', -8, AVAIL);
      const after = rendered(AVAIL);
      const { prefs } = useColumnPrefs.getState();
      expect([prefs.author, prefs.date]).toEqual([after.author, after.date]);
      const wide = rendered(1400);
      expect([wide.author, wide.date]).toEqual([after.author, after.date]);
    });

    it('a stray click (no movement) or a drag back to where it started adopts nothing it has not moved', () => {
      const s = useColumnPrefs.getState();
      s.beginResize('author', rendered(AVAIL), AVAIL);
      s.resizeBy(0);
      s.endResize();
      expect(useColumnPrefs.getState().prefs).toEqual(DEFAULT_COLUMN_PREFS);
      const start = rendered(AVAIL);
      s.beginResize('author', start, AVAIL);
      useColumnPrefs.getState().resizeBy(-10);
      useColumnPrefs.getState().resizeBy(0);
      useColumnPrefs.getState().endResize();
      expect(rendered(AVAIL)).toEqual(start);
    });
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

describe('the SHA column (F3 review, H15): a preference between SHORT_SHA_LEN (6) and 40 hex characters', () => {
  beforeEach(() => useColumnPrefs.getState().reset());

  it('min fits the app-wide 6 hex characters with 1 px to spare (a slightly wider ch under CEF or zoom), max all 40 (13 px ui-monospace, 1ch = 7.83 px, plus 6 + 6 px padding); the default is the minimum, so it shows exactly 6 (H15)', () => {
    expect(COLUMN_MIN.sha).toBe(Math.ceil(6 * 7.83 + 12) + 1);
    expect(SHA_MAX).toBe(Math.ceil(40 * 7.83 + 12));
    expect(DEFAULT_COLUMN_PREFS.sha).toBe(SHA_W);
    expect(SHA_W).toBe(COLUMN_MIN.sha);
  });

  it('allocateColumns renders the SHA preference, clamped to [min, max], like Branch/Tag and Graph', () => {
    expect(allocateColumns({ ...prefs, sha: 100 }, 1400).sha).toBe(100);
    expect(allocateColumns({ ...prefs, sha: 10 }, 1400).sha).toBe(COLUMN_MIN.sha);
    expect(allocateColumns({ ...prefs, sha: 9000 }, 1400).sha).toBe(SHA_MAX);
    expect(allocateColumns(prefs, 1400).sha).toBe(SHA_W);
  });

  it('Date\'s handle trades 1:1 with SHA and holds both walls: SHA\'s minimum and maximum, no fallback to Message', () => {
    const start = rendered(1400);
    // Right: SHA starts at its minimum (H15), so Date can't grow into it at all.
    drag('date', 20, 1400, (d, w) => {
      const moved = Math.min(d, SHA_W - COLUMN_MIN.sha);
      expect(edges(w).date, `d=${d}`).toBe(edges(start).date + moved);
      expect([w.date, w.sha, w.message, w.author]).toEqual([start.date + moved, start.sha - moved, start.message, start.author]);
    });
    // Left: Date gives SHA width up to SHA's maximum (then stops, however far the pointer goes).
    useColumnPrefs.getState().reset();
    drag('date', -(SHA_MAX - SHA_W + 30), 1400, (d, w) => {
      const moved = Math.min(-d, SHA_MAX - SHA_W, start.date - COLUMN_MIN.date);
      expect(edges(w).date, `d=${d}`).toBe(edges(start).date - moved);
      expect([w.date, w.sha, w.message]).toEqual([start.date - moved, start.sha + moved, start.message]);
    });
    expect(handleRange('date', rendered(1400), 1400).min).toBe(rendered(1400).date);
  });

  it('SHA widths persist through the same per-repo seam, and a stored set without SHA gets the default', () => {
    const save = vi.spyOn(columnPrefsPersistence, 'save');
    vi.spyOn(columnPrefsPersistence, 'load').mockImplementation(() => ({ labels: 250, graph: null, author: 160, date: 170 }) as never);
    useColumnPrefs.getState().loadFor('/repo/sha');
    expect(useColumnPrefs.getState().prefs).toEqual({ ...DEFAULT_COLUMN_PREFS, labels: 250 });
    press('date', -20, 1400);
    expect(save).toHaveBeenLastCalledWith('/repo/sha', expect.objectContaining({ sha: SHA_W + 20, date: 150 }));
    vi.restoreAllMocks();
  });
});

describe('the Graph column is capped at what its lanes need (F2)', () => {
  beforeEach(() => useColumnPrefs.getState().reset());
  const m = { laneW: 16, padX: 8 };

  it('lanesWidth is every lane plus the node padding; autoGraphWidth floors it at 64', () => {
    expect(lanesWidth(10, m)).toBe(176);
    expect(lanesWidth(1, m)).toBe(32);
    expect(autoGraphWidth(1, m)).toBe(64);
  });

  it('a drag or key press can\'t widen Graph past graphMax, and narrowing still tracks', () => {
    const graphMax = 200;
    useColumnPrefs.getState().setWidth('graph', 100);
    const s = useColumnPrefs.getState();
    s.beginResize('graph', rendered(1400), 1400, graphMax);
    for (let d = 1; d <= 300; d++) {
      useColumnPrefs.getState().resizeBy(d);
      expect(useColumnPrefs.getState().prefs.graph, `d=${d}`).toBe(Math.min(100 + d, graphMax));
    }
    useColumnPrefs.getState().endResize();
    expect(useColumnPrefs.getState().prefs.graph).toBeNull(); // at the cap: auto
    s.beginResize('graph', { ...rendered(1400), graph: graphMax }, 1400, graphMax);
    useColumnPrefs.getState().resizeBy(8);
    useColumnPrefs.getState().endResize();
    expect(useColumnPrefs.getState().prefs.graph).toBeNull();
    s.beginResize('graph', { ...rendered(1400), graph: graphMax }, 1400, graphMax);
    useColumnPrefs.getState().resizeBy(-8);
    useColumnPrefs.getState().endResize();
    expect(useColumnPrefs.getState().prefs.graph).toBe(graphMax - 8);
  });

  it('a gesture that ends at the cap stores "auto" (null), so more lanes auto-fit again; one below it keeps the number', () => {
    const graphMax = 200;
    useColumnPrefs.getState().setWidth('graph', 150);
    const s = useColumnPrefs.getState();
    s.beginResize('graph', { ...rendered(1400), graph: 150 }, 1400, graphMax);
    useColumnPrefs.getState().resizeBy(80);
    useColumnPrefs.getState().endResize();
    expect(useColumnPrefs.getState().prefs.graph).toBeNull();
    s.beginResize('graph', { ...rendered(1400), graph: graphMax }, 1400, graphMax);
    useColumnPrefs.getState().resizeBy(-8);
    useColumnPrefs.getState().endResize();
    expect(useColumnPrefs.getState().prefs.graph).toBe(graphMax - 8);
  });

  it('handleRange reports the cap as the Graph handle\'s max', () => {
    const w = allocateColumns({ ...DEFAULT_COLUMN_PREFS, graph: 100 }, 1400);
    expect(handleRange('graph', w, 1400, 150).max).toBe(150);
    expect(handleRange('graph', w, 1400).max).toBe(columnMax('graph', 1400));
  });
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

describe('hidden and collapsed columns (T16a, spec §8.4)', () => {
  beforeEach(() => useColumnPrefs.getState().reset());
  afterEach(() => vi.restoreAllMocks());

  it('hidden columns take no width and give it to Message', () => {
    const all = allocateColumns(prefs, 1200);
    const some = allocateColumns(prefs, 1200, new Set(['author', 'sha'] as const));
    expect(some.author).toBe(0);
    expect(some.sha).toBe(0);
    expect(some.message).toBe(all.message + all.author + all.sha);
    expect(some.total).toBe(1200);
    expect(allocateColumns(prefs, 1200, new Set(['labels'] as const)).labels).toBe(0);
    expect(allocateColumns({ ...prefs, sha: 200 }, 1200, new Set(['date'] as const))).toMatchObject({ date: 0, sha: 200 });
  });

  it('squeezing takes room only from the visible one of Author and Date', () => {
    // Message at its minimum needs 60 px more than there is: Author is hidden, so all of it comes out of Date.
    const tight = prefs.labels + prefs.graph + prefs.date + SHA_W + COLUMN_MIN.message - 60;
    const w = allocateColumns(prefs, tight, new Set(['author'] as const));
    expect(w).toMatchObject({ author: 0, date: prefs.date - 60, message: COLUMN_MIN.message, total: tight });
    // Far too narrow: Date stops at its minimum, Author stays hidden (0, not its minimum).
    expect(allocateColumns(prefs, 300, new Set(['author'] as const))).toMatchObject({ author: 0, date: COLUMN_MIN.date });
  });

  it('a column at its minimum is collapsed', () => {
    expect(isCollapsed('labels', COLUMN_MIN.labels)).toBe(true);
    expect(isCollapsed('labels', COLUMN_MIN.labels + 1)).toBe(false);
    expect(isCollapsed('graph', COLUMN_MIN.graph)).toBe(true);
    expect(isCollapsed('author', COLUMN_MIN.author)).toBe(true);
    expect(isCollapsed('date', COLUMN_MIN.date + 20)).toBe(false);
  });

  it('a handle shows only while its column and the one it trades with are both shown', () => {
    const none = new Set<never>();
    for (const c of ['labels', 'graph', 'message', 'author', 'date'] as const) expect(handleShown(c, none), c).toBe(true);
    expect(handleShown('labels', new Set(['labels'] as const))).toBe(false);
    expect(handleShown('graph', new Set(['labels', 'author', 'date', 'sha'] as const))).toBe(true);
    expect(handleShown('message', new Set(['author'] as const))).toBe(false);
    expect(handleShown('author', new Set(['date'] as const))).toBe(false);
    expect(handleShown('date', new Set(['sha'] as const))).toBe(false);
    expect(handleShown('date', new Set(['author'] as const))).toBe(true);
  });

  it('the hidden set loads per repo through its own seam and saves on every toggle', () => {
    const load = vi.spyOn(hiddenColumnsPersistence, 'load').mockImplementation((id) => (id === '/repo/b' ? ['date'] : null));
    const save = vi.spyOn(hiddenColumnsPersistence, 'save');
    const s = useColumnPrefs.getState();
    s.loadFor('/repo/a');
    expect(load).toHaveBeenLastCalledWith('/repo/a');
    expect([...useColumnPrefs.getState().hidden]).toEqual([]);
    useColumnPrefs.getState().toggleHidden('author');
    expect([...useColumnPrefs.getState().hidden]).toEqual(['author']);
    expect(save).toHaveBeenLastCalledWith('/repo/a', ['author']);
    useColumnPrefs.getState().toggleHidden('author');
    expect([...useColumnPrefs.getState().hidden]).toEqual([]);
    expect(save).toHaveBeenLastCalledWith('/repo/a', []);
    useColumnPrefs.getState().loadFor('/repo/b');
    expect([...useColumnPrefs.getState().hidden]).toEqual(['date']);
    // A stored name that isn't a hideable column (Graph, Message, a typo) is dropped.
    load.mockImplementation(() => ['graph', 'message', 'sha', 'nope'] as never);
    useColumnPrefs.getState().loadFor('/repo/c');
    expect([...useColumnPrefs.getState().hidden]).toEqual(['sha']);
    useColumnPrefs.getState().reset();
    expect(useColumnPrefs.getState().hidden.size).toBe(0);
  });
});
