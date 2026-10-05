import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { arrive, canGoBack, canGoForward, dropAt, dropHistory, EMPTY_HISTORY, historyOf, MAX_PLACES, navBack, navForward, placeKey, recordPlace, registerPlaceKind, step, useNavHistory, type NavHistory, type Place } from './history';

const A = 'a'.repeat(40);
const mr = (number: number, scrollTop = 0): Place => ({ kind: 'mr', number, scrollTop });
const file = (path: string, commit = A, scrollTop = 0): Place => ({ kind: 'file', path, commit, view: 'rendered', scrollTop });
const commit = (sha: string): Place => ({ kind: 'commit', sha });
const keysOf = (h: NavHistory) => h.places.map(placeKey);
const keys = (tabId = 't') => keysOf(historyOf(tabId));
const at = (tabId = 't') => {
  const h = historyOf(tabId);
  const p = h.places[h.cursor];
  return p ? placeKey(p) : null;
};

describe('the history (pure)', () => {
  it('a push appends the place and moves the cursor onto it', () => {
    const h = arrive(arrive(EMPTY_HISTORY, mr(12)), file('README.md'));
    expect(keysOf(h)).toEqual(['mr:12', `file:${A}:README.md`]);
    expect(h.cursor).toBe(1);
  });

  it('arriving at the place already current changes nothing', () => {
    const h = arrive(EMPTY_HISTORY, mr(12, 300));
    expect(arrive(h, mr(12))).toBe(h);
  });

  it('going somewhere new after Back drops the forward entries', () => {
    const h = arrive(arrive(arrive(EMPTY_HISTORY, mr(1)), mr(2)), mr(3));
    const back = step(step(h, -1)!, -1)!;
    expect(keysOf(arrive(back, commit('c1')))).toEqual(['mr:1', 'commit:c1']);
  });

  it(`keeps at most ${MAX_PLACES} places, dropping the oldest`, () => {
    let h = EMPTY_HISTORY;
    for (let n = 1; n <= MAX_PLACES + 5; n++) h = arrive(h, mr(n));
    expect(h.places).toHaveLength(MAX_PLACES);
    expect(placeKey(h.places[0])).toBe('mr:6');
    expect(h.cursor).toBe(MAX_PLACES - 1);
  });

  it('replace swaps the current place for one of the same kind, and pushes otherwise', () => {
    const h = arrive(arrive(EMPTY_HISTORY, file('a.md')), mr(12));
    expect(keysOf(arrive(h, mr(5), 'replace'))).toEqual([`file:${A}:a.md`, 'mr:5']);
    expect(keysOf(arrive(h, commit('c1'), 'replace'))).toEqual([`file:${A}:a.md`, 'mr:12', 'commit:c1']);
    expect(keysOf(arrive(EMPTY_HISTORY, mr(5), 'replace'))).toEqual(['mr:5']);
  });

  it('step stops at either end', () => {
    const h = arrive(arrive(EMPTY_HISTORY, mr(1)), mr(2));
    expect(step(h, 1)).toBeNull();
    expect(step(h, -1)!.cursor).toBe(0);
    expect(step(step(h, -1)!, -1)).toBeNull();
    expect(step(EMPTY_HISTORY, -1)).toBeNull();
  });

  it('dropAt removes a place and leaves the cursor on the one the step came from', () => {
    const h: NavHistory = { places: [mr(1), mr(2), mr(3)], cursor: 1 };
    // Back from !3 to !2, and !2 is gone: the cursor is on !3, now at index 1.
    expect(dropAt(h, 1, -1)).toEqual({ places: [mr(1), mr(3)], cursor: 1 });
    // Forward from !1 to !2, and !2 is gone: the cursor is on !1.
    expect(dropAt(h, 1, 1)).toEqual({ places: [mr(1), mr(3)], cursor: 0 });
  });
});

describe('recordPlace, navBack and navForward', () => {
  const restored: string[] = [];
  let gone: Set<string>;
  let scroll: number | null;
  let offs: Array<() => void> = [];
  beforeEach(() => {
    useNavHistory.setState({ byTab: {} });
    restored.length = 0;
    gone = new Set();
    scroll = null;
    const restore = async (_tabId: string, p: Place) => {
      restored.push(placeKey(p));
      return !gone.has(placeKey(p));
    };
    offs = [
      registerPlaceKind('mr', { capture: (_t, p) => (scroll === null ? null : { ...p, scrollTop: scroll }), restore }),
      registerPlaceKind('file', { restore }),
      registerPlaceKind('commit', { restore }),
    ];
  });
  afterEach(() => offs.forEach((off) => off()));

  it('Back and Forward restore the places in order, and Back at the start does nothing', async () => {
    recordPlace('t', mr(12));
    recordPlace('t', mr(5));
    recordPlace('t', file('README.md'));
    expect(canGoBack('t')).toBe(true);
    expect(canGoForward('t')).toBe(false);
    await navBack('t');
    await navBack('t');
    expect(restored).toEqual(['mr:5', 'mr:12']);
    expect(at()).toBe('mr:12');
    await navBack('t');
    expect(restored).toHaveLength(2);
    expect(at()).toBe('mr:12');
    await navForward('t');
    expect(restored.at(-1)).toBe('mr:5');
    expect(canGoForward('t')).toBe(true);
  });

  it('every arrival and step first saves the scroll of the place being left', async () => {
    recordPlace('t', mr(12));
    scroll = 340;
    recordPlace('t', file('README.md'));
    expect(historyOf('t').places[0]).toEqual(mr(12, 340));
    scroll = null;
    await navBack('t');
    scroll = 80;
    await navForward('t');
    expect(historyOf('t').places[0]).toEqual(mr(12, 80));
  });

  it('a place that is gone is skipped and dropped, and the step goes on past it', async () => {
    recordPlace('t', mr(1));
    recordPlace('t', commit('c1'));
    recordPlace('t', mr(3));
    gone.add('commit:c1');
    await navBack('t');
    expect(restored).toEqual(['commit:c1', 'mr:1']);
    expect(keys()).toEqual(['mr:1', 'mr:3']);
    expect(at()).toBe('mr:1');
    await navForward('t');
    expect(at()).toBe('mr:3');
  });

  it('when every place that way is gone, the cursor stays where it was', async () => {
    recordPlace('t', mr(1));
    recordPlace('t', mr(2));
    gone.add('mr:1');
    await navBack('t');
    expect(keys()).toEqual(['mr:2']);
    expect(at()).toBe('mr:2');
  });

  it('a restore that throws counts as gone', async () => {
    offs.push(registerPlaceKind('commit', { restore: async () => { throw new Error('boom'); } }));
    recordPlace('t', mr(1));
    recordPlace('t', commit('c1'));
    recordPlace('t', mr(3));
    await navBack('t');
    expect(at()).toBe('mr:1');
    expect(keys()).toEqual(['mr:1', 'mr:3']);
  });

  it('a newer step or arrival wins over a restore still loading', async () => {
    let release!: () => void;
    offs.push(registerPlaceKind('mr', {
      restore: (_t, p) => {
        restored.push(placeKey(p));
        return p.number === 2 ? new Promise<boolean>((r) => { release = () => r(false); }) : Promise.resolve(true);
      },
    }));
    recordPlace('t', mr(1));
    recordPlace('t', mr(2));
    recordPlace('t', mr(3));
    const slow = navBack('t'); // to !2, still loading
    recordPlace('t', commit('c9')); // the user went somewhere else meanwhile
    release(); // !2 turns out gone: too late to matter
    await slow;
    expect(keys()).toEqual(['mr:1', 'mr:2', 'commit:c9']);
    expect(at()).toBe('commit:c9');
  });

  it('arriving where the history already is (a restore opening its own place) adds nothing', async () => {
    offs.push(registerPlaceKind('mr', { restore: async (_t, p) => { recordPlace('t', p); return true; } }));
    recordPlace('t', mr(12));
    recordPlace('t', mr(5));
    await navBack('t');
    expect(keys()).toEqual(['mr:12', 'mr:5']);
    expect(at()).toBe('mr:12');
  });

  it('a place of a kind nobody registered is gone', async () => {
    offs.forEach((off) => off());
    offs = [];
    recordPlace('t', mr(1));
    recordPlace('t', mr(2));
    await navBack('t');
    expect(keys()).toEqual(['mr:2']);
  });

  it('each tab has its own history, dropped with the tab', () => {
    recordPlace('t', mr(1));
    recordPlace('u', mr(2));
    expect(keys('t')).toEqual(['mr:1']);
    expect(keys('u')).toEqual(['mr:2']);
    dropHistory('t');
    expect(historyOf('t')).toEqual(EMPTY_HISTORY);
    expect(keys('u')).toEqual(['mr:2']);
  });
});
