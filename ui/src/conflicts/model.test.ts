import { describe, expect, it } from 'vitest';
import { anyPicked, buildOutput, changeHits, emptyPicks, eolText, hasMarkers, regionText, hunkState, nextRegion, openingRegion, regionLines, sideHasLines, sideState, takeAll, toggleHunk, toggleLine, unpickedCount, type ConflictSegment, type Segment } from './model';

const segs: Segment[] = [
  { kind: 'common', text: 'one\ntwo\n' },
  { kind: 'conflict', id: 0, base: ['three\n'], current: ['current three\n', 'current extra\n'], incoming: ['incoming three\n'] },
  { kind: 'common', text: 'four\n' },
  { kind: 'conflict', id: 1, base: [], current: [], incoming: ['incoming only\n'] },
  { kind: 'common', text: 'five' },
];
const c0 = segs[1] as ConflictSegment;
const c1 = segs[3] as ConflictSegment;

describe('the merge tool model (spec #2 §13.3)', () => {
  it('starts with nothing picked: every region is empty in the output', () => {
    const out = buildOutput(segs, emptyPicks(segs));
    expect(out.text).toBe('one\ntwo\nfour\nfive');
    expect(out.regions).toEqual([{ id: 0, start: 3, lines: 0 }, { id: 1, start: 4, lines: 0 }]);
    expect(unpickedCount(segs, emptyPicks(segs), new Set())).toBe(2);
  });

  it('fills a region with the ticked lines, the side ticked first leading, each side in file order', () => {
    let p = emptyPicks(segs);
    p = toggleLine(p, 0, 'current', 1);
    p = toggleLine(p, 0, 'incoming', 0);
    p = toggleLine(p, 0, 'current', 0);
    expect(regionLines(c0, p[0])).toEqual(['current three\n', 'current extra\n', 'incoming three\n']);
    const out = buildOutput(segs, p);
    expect(out.text).toBe('one\ntwo\ncurrent three\ncurrent extra\nincoming three\nfour\nfive');
    expect(out.regions).toEqual([{ id: 0, start: 3, lines: 3 }, { id: 1, start: 7, lines: 0 }]);
  });

  it('Incoming ticked before Current: its lines come first, by line or by hunk', () => {
    let p = toggleLine(emptyPicks(segs), 0, 'incoming', 0);
    p = toggleLine(p, 0, 'current', 1);
    expect(regionLines(c0, p[0])).toEqual(['incoming three\n', 'current extra\n']);
    expect(buildOutput(segs, p).text).toBe('one\ntwo\nincoming three\ncurrent extra\nfour\nfive');
    p = toggleHunk(toggleHunk(emptyPicks(segs), c0, 'incoming'), c0, 'current');
    expect(regionLines(c0, p[0])).toEqual(['incoming three\n', 'current three\n', 'current extra\n']);
  });

  it('a side unticked and ticked again moves to the end; a partial untick keeps its place', () => {
    let p = toggleHunk(emptyPicks(segs), c0, 'current');
    p = toggleHunk(p, c0, 'incoming');
    p = toggleLine(p, 0, 'current', 0);
    expect(regionLines(c0, p[0])).toEqual(['current extra\n', 'incoming three\n']);
    p = toggleHunk(p, c0, 'current');
    p = toggleHunk(p, c0, 'current');
    expect(hunkState(c0, p[0], 'current')).toBe('none');
    expect(regionLines(c0, p[0])).toEqual(['incoming three\n']);
    p = toggleLine(p, 0, 'current', 1);
    expect(regionLines(c0, p[0])).toEqual(['incoming three\n', 'current extra\n']);
    // The order is in the picks, so it's kept with them (a draft's JSON).
    expect(regionLines(c0, JSON.parse(JSON.stringify(p))[0])).toEqual(['incoming three\n', 'current extra\n']);
  });

  it("each region keeps its own order; a draft's picks from before the order lead with Current", () => {
    let p = toggleLine(emptyPicks(segs), 0, 'incoming', 0);
    p = toggleLine(p, 0, 'current', 0);
    p = toggleHunk(p, c1, 'incoming');
    expect(buildOutput(segs, p).text).toBe('one\ntwo\nincoming three\ncurrent three\nfour\nincoming only\nfive');
    expect(regionLines(c0, { current: [true, false], incoming: [true] })).toEqual(['current three\n', 'incoming three\n']);
  });

  it('take all from a side takes that side alone, so the order is just its own', () => {
    let p = toggleLine(emptyPicks(segs), 0, 'incoming', 0);
    p = takeAll(p, segs, 'current', true);
    expect(regionLines(c0, p[0])).toEqual(['current three\n', 'current extra\n']);
    p = toggleLine(p, 0, 'incoming', 0);
    expect(regionLines(c0, p[0])).toEqual(['current three\n', 'current extra\n', 'incoming three\n']);
  });

  it('opens at the first region with nothing ticked or typed, else the first', () => {
    expect(openingRegion(segs, emptyPicks(segs), new Set())).toBe(0);
    const p = toggleLine(emptyPicks(segs), 0, 'incoming', 0);
    expect(openingRegion(segs, p, new Set())).toBe(1);
    expect(openingRegion(segs, emptyPicks(segs), new Set([0]))).toBe(1);
    expect(openingRegion(segs, toggleHunk(p, c1, 'incoming'), new Set())).toBe(0);
    expect(openingRegion([{ kind: 'common', text: 'x\n' }], {}, new Set())).toBeNull();
  });

  it("a hunk's checkbox ticks its side's lines, or unticks them all when all were ticked", () => {
    let p = toggleHunk(emptyPicks(segs), c0, 'current');
    expect(hunkState(c0, p[0], 'current')).toBe('all');
    p = toggleLine(p, 0, 'current', 0);
    expect(hunkState(c0, p[0], 'current')).toBe('some');
    p = toggleHunk(p, c0, 'current');
    expect(hunkState(c0, p[0], 'current')).toBe('all');
    p = toggleHunk(p, c0, 'current');
    expect(hunkState(c0, p[0], 'current')).toBe('none');
  });

  it('take all from a side picks it everywhere and drops the other side; unticked, it clears that side', () => {
    let p = toggleLine(emptyPicks(segs), 0, 'current', 0);
    p = takeAll(p, segs, 'incoming', true);
    expect(sideState(segs, p, 'incoming')).toBe('all');
    expect(sideState(segs, p, 'current')).toBe('none');
    expect(buildOutput(segs, p).text).toBe('one\ntwo\nincoming three\nfour\nincoming only\nfive');
    p = takeAll(p, segs, 'incoming', false);
    expect(sideState(segs, p, 'incoming')).toBe('none');
  });

  it('a side with no lines in a region counts as all for its checkbox, never blocks it', () => {
    const p = takeAll(emptyPicks(segs), segs, 'current', true);
    expect(hunkState(c1, p[1], 'current')).toBe('all');
    expect(sideState(segs, p, 'current')).toBe('all');
  });

  it('a hand-edited region with nothing ticked isn\'t "unpicked"', () => {
    expect(unpickedCount(segs, emptyPicks(segs), new Set([0]))).toBe(1);
  });

  it('F7 and Shift+F7 move between regions, wrapping', () => {
    const regions = [{ id: 0, start: 3, lines: 2 }, { id: 1, start: 9, lines: 0 }];
    expect(nextRegion(regions, 1, 1)?.id).toBe(0);
    expect(nextRegion(regions, 3, 1)?.id).toBe(1);
    expect(nextRegion(regions, 9, 1)?.id).toBe(0);
    expect(nextRegion(regions, 9, -1)?.id).toBe(0);
    expect(nextRegion(regions, 3, -1)?.id).toBe(1);
    expect(nextRegion([], 3, 1)).toBeNull();
  });

  it('keeps each line\'s own terminator; the file\'s EOL goes in only after a ticked last line that has none (the EOL ruling)', () => {
    const eof: Segment[] = [
      { kind: 'common', text: 'one\r\n' },
      { kind: 'conflict', id: 0, base: ['b'], current: ['cur\r\n', 'cur end'], incoming: ['inc end'] },
    ];
    let p = takeAll(emptyPicks(eof), eof, 'current', true);
    expect(buildOutput(eof, p, eolText('crlf')).text).toBe('one\r\ncur\r\ncur end');
    p = toggleLine(p, 0, 'incoming', 0);
    const out = buildOutput(eof, p, eolText('crlf'));
    expect(out.text).toBe('one\r\ncur\r\ncur end\r\ninc end');
    expect(out.regions).toEqual([{ id: 0, start: 2, lines: 3 }]);
    expect(regionText(['a\n', 'b'], '\n')).toBe('a\nb');
    expect(regionText(['a', 'b\n'], '\n')).toBe('a\nb\n');
    expect(eolText('lf')).toBe('\n');
    expect(eolText('mixed')).toBe('\n');
  });

  it('knows when anything is ticked, and which sides have lines at all', () => {
    expect(anyPicked(emptyPicks(segs))).toBe(false);
    expect(anyPicked(toggleLine(emptyPicks(segs), 1, 'incoming', 0))).toBe(true);
    expect(sideHasLines(segs, 'current')).toBe(true);
    expect(sideHasLines([segs[3]], 'current')).toBe(false);
  });

  it("a change is in a region when it touches its text or its start; typing at its end isn't (M1)", () => {
    // Region [4, 6): "c\n" of "one\nc\ntwo\n".
    expect(changeHits(4, 0, 'x', 4, 6)).toBe(true);
    expect(changeHits(5, 0, 'x', 4, 6)).toBe(true);
    expect(changeHits(6, 0, 'x', 4, 6)).toBe(false);
    expect(changeHits(3, 2, '', 4, 6)).toBe(true);
    expect(changeHits(6, 2, '', 4, 6)).toBe(false);
    // An empty region at 4: typing there fills it.
    expect(changeHits(4, 0, 'x', 4, 4)).toBe(true);
    expect(changeHits(4, 1, '', 4, 4)).toBe(false);
    // N5: a region ending the file without a final newline ("c" of "one\nc"): typing after "c"
    // is on its last line.
    expect(changeHits(5, 0, 'x', 4, 5, true)).toBe(true);
    expect(changeHits(5, 0, 'x', 4, 5)).toBe(false);
  });

  it('finds leftover conflict markers', () => {
    expect(hasMarkers('a\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> feature\n')).toBe(true);
    expect(hasMarkers('a\n======= not a marker line\n')).toBe(false);
    expect(hasMarkers('<<<<<<< HEAD\nx\n')).toBe(false);
  });
});
