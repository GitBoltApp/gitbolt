import { describe, expect, it } from 'vitest';
import { openTop, revealTop, stepTarget, type ChangeBox } from './changeNav';

// Changes 20 px tall at 400, 700, 1000 and 1300; a 300 px view (its centre 150 px down it).
const boxes: ChangeBox[] = [400, 700, 1000, 1300].map((top) => ({ top, bottom: top + 20 }));
const at = (top: number) => ({ top, height: 300 });

describe('stepTarget: Next/Previous change from where the view is', () => {
  it('above the first change: Next is the first, Previous wraps to the last', () => {
    expect(stepTarget(boxes, at(0), 'next')).toBe(0);
    expect(stepTarget(boxes, at(0), 'previous')).toBe(3);
  });

  it('between changes: Next the first one starting below the centre, Previous the last one ending above it', () => {
    // Centre at 550: between change 0 (400) and change 1 (700).
    expect(stepTarget(boxes, at(400), 'next')).toBe(1);
    expect(stepTarget(boxes, at(400), 'previous')).toBe(0);
  });

  it('centred on a change (Next just went there): Next the following one, Previous the one before', () => {
    // Change 1 (700-720) centred: centre at 710.
    expect(stepTarget(boxes, at(560), 'next')).toBe(2);
    expect(stepTarget(boxes, at(560), 'previous')).toBe(0);
  });

  it('below the last change: Previous is the last, Next wraps to the first', () => {
    expect(stepTarget(boxes, at(1300), 'previous')).toBe(3);
    expect(stepTarget(boxes, at(1300), 'next')).toBe(0);
  });

  it('a tall change across the centre is the current one: neither step stays on it', () => {
    const tall: ChangeBox[] = [{ top: 100, bottom: 120 }, { top: 300, bottom: 900 }, { top: 1000, bottom: 1020 }];
    expect(stepTarget(tall, at(400), 'next')).toBe(2);
    expect(stepTarget(tall, at(400), 'previous')).toBe(0);
  });

  it('the view where a reveal left it (`current`): steps from that change, even where it could not be centred', () => {
    // The last change sits in the bottom half of a view scrolled to the end: by the centre alone,
    // Next would go to it again.
    expect(stepTarget(boxes, at(1100), 'next')).toBe(3);
    expect(stepTarget(boxes, at(1100), 'next', 3)).toBe(0);
    expect(stepTarget(boxes, at(1100), 'previous', 3)).toBe(2);
    // The first screen, opened at the top on change 0: changes 0 and 1 are both above the centre.
    const tallView = { top: 0, height: 1600 };
    expect(stepTarget(boxes, tallView, 'next')).toBe(2);
    expect(stepTarget(boxes, tallView, 'next', 0)).toBe(1);
    expect(stepTarget(boxes, tallView, 'previous', 0)).toBe(3);
  });

  it('no changes: nothing to step to', () => {
    expect(stepTarget([], at(0), 'next')).toBeNull();
    expect(stepTarget([], at(0), 'previous', 0)).toBeNull();
  });
});

describe('revealTop / openTop: where a change is put', () => {
  it('centred in the view', () => {
    expect(revealTop({ top: 400, bottom: 420 }, 300, 57)).toBe(410 - 150);
  });

  it('taller than the view (less its margins): its start `margin` below the top', () => {
    expect(revealTop({ top: 400, bottom: 650 }, 300, 57)).toBe(400 - 57);
  });

  it('never above the top of the content', () => {
    expect(revealTop({ top: 20, bottom: 40 }, 300, 57)).toBe(0);
  });

  it('opening: at the top when the first change shows there whole, else centred', () => {
    expect(openTop({ top: 250, bottom: 300 }, 300, 57)).toBe(0);
    expect(openTop({ top: 250, bottom: 301 }, 300, 57)).toBe(275.5 - 150);
    expect(openTop({ top: 2280, bottom: 2299 }, 300, 57)).toBe(2289.5 - 150);
  });
});
