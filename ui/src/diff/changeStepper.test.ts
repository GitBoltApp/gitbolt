import { describe, expect, it } from 'vitest';
import { changeTargets, setChangeStepper, changeStepper, STEP_MARGIN, stepChange } from './changeStepper';

/** A pane whose children sit at the given offsets from its top (jsdom has no layout). */
function pane(rows: Array<[string | null, number]>, nested?: [number, string]) {
  const p = document.createElement('div');
  let top = 0;
  Object.defineProperty(p, 'scrollTop', { get: () => top, set: (v: number) => { top = v; } });
  p.getBoundingClientRect = () => ({ top: 100 }) as DOMRect;
  for (const [mark, y] of rows) {
    const el = document.createElement('div');
    if (mark) el.setAttribute('data-diff-mark', mark);
    el.getBoundingClientRect = () => ({ top: 100 + y }) as DOMRect;
    p.append(el);
  }
  if (nested) {
    const inner = document.createElement('div');
    inner.setAttribute('data-diff-mark', nested[1]);
    p.children[nested[0]]!.append(inner);
  }
  return p;
}

describe('the rendered change stepper (5C, R3)', () => {
  it('targets each marked element, never a mark inside another: a removed then added block is two stops', () => {
    const p = pane([[null, 0], ['added', 40], ['removed', 80], ['added', 120], [null, 200], ['pair', 300]], [5, 'removed']);
    expect(changeTargets(p).map((e) => e.getAttribute('data-diff-mark'))).toEqual(['added', 'removed', 'added', 'pair']);
  });

  it("a split row holding a container (a table, a list) gives its marked rows or items: the new side's, and the old side's removed ones", () => {
    const p = document.createElement('div');
    p.innerHTML = `
      <div class="md-split-row" data-diff-mark="changed">
        <div class="md-split-cell"><table><tbody><tr><td>a</td></tr><tr data-diff-mark="changed" id="o1"><td>b</td></tr><tr data-diff-mark="removed" id="o2"><td>c</td></tr><tr class="md-split-empty-row"><td> </td></tr></tbody></table></div>
        <div class="md-split-cell"><table><tbody><tr><td>a</td></tr><tr data-diff-mark="changed" id="n1"><td>B</td></tr><tr class="md-split-empty-row"><td> </td></tr><tr data-diff-mark="added" id="n3"><td>d</td></tr></tbody></table></div>
      </div>
      <div class="md-split-row" data-diff-mark="changed" id="para">
        <div class="md-split-cell"><div data-diff-mark="changed">old words</div></div>
        <div class="md-split-cell"><div data-diff-mark="changed">new words</div></div>
      </div>
      <div class="md-split-row" data-diff-mark="removed" id="gone">
        <div class="md-split-cell"><div data-diff-mark="removed">gone</div></div>
        <div class="md-split-cell md-split-empty"></div>
      </div>`;
    expect(changeTargets(p).map((e) => e.id)).toEqual(['n1', 'n3', 'o2', 'para', 'gone']);
  });

  /** A 300 px pane scrolled over changes 20 px tall (or `h`) at the given offsets in its content. */
  function scrolled(rows: Array<[string | null, number, number?]>) {
    const p = document.createElement('div');
    let top = 0;
    Object.defineProperty(p, 'scrollTop', { get: () => top, set: (v: number) => { top = Math.max(0, v); } });
    Object.defineProperty(p, 'clientHeight', { get: () => 300 });
    p.getBoundingClientRect = () => ({ top: 100 }) as DOMRect;
    for (const [mark, y, h = 20] of rows) {
      const el = document.createElement('div');
      if (mark) el.setAttribute('data-diff-mark', mark);
      el.getBoundingClientRect = () => ({ top: 100 + y - top, bottom: 100 + y + h - top }) as DOMRect;
      p.append(el);
    }
    return p;
  }
  /** The scroll that centres a 20 px change at `y` in the 300 px pane. */
  const centring = (y: number) => y + 10 - 150;

  it('steps by position even when targets come out of order (a split row: new side first)', () => {
    const p = scrolled([['added', 1000], ['removed', 400]]);
    stepChange(p, 'next');
    expect(p.scrollTop).toBe(centring(400));
  });

  it("goes by the scroll: Next the first change starting below the pane's centre line, Previous the last one ending above it, centred", () => {
    const p = scrolled([[null, 0], ['added', 400], [null, 700], ['changed', 1000]]);
    expect(stepChange(p, 'next')).toBe(true);
    expect(p.scrollTop).toBe(centring(400));
    stepChange(p, 'next');
    expect(p.scrollTop).toBe(centring(1000));
    stepChange(p, 'previous');
    expect(p.scrollTop).toBe(centring(400));
    // Scrolled past the last: Previous is the last one above, not the one before the last step.
    p.scrollTop = 2000;
    stepChange(p, 'previous');
    expect(p.scrollTop).toBe(centring(1000));
    // Between the two (the centre at 750).
    p.scrollTop = 600;
    stepChange(p, 'next');
    expect(p.scrollTop).toBe(centring(1000));
    p.scrollTop = 600;
    stepChange(p, 'previous');
    expect(p.scrollTop).toBe(centring(400));
  });

  it('a change taller than the pane starts STEP_MARGIN below its top', () => {
    const p = scrolled([['added', 400, 500]]);
    stepChange(p, 'next');
    expect(p.scrollTop).toBe(400 - STEP_MARGIN);
  });

  it('wraps: past the last change to the first, before the first to the last', () => {
    const p = scrolled([['added', 400], [null, 700], ['changed', 1000]]);
    p.scrollTop = 2000;
    expect(stepChange(p, 'next')).toBe(true);
    expect(p.scrollTop).toBe(centring(400));
    const q = scrolled([[null, 0], ['added', 400], ['changed', 1000]]);
    expect(stepChange(q, 'previous')).toBe(true);
    expect(q.scrollTop).toBe(centring(1000));
    expect(stepChange(scrolled([[null, 0]]), 'next')).toBe(false);
  });

  it('on from the change it put the pane on, where the pane could not centre it (the first screen)', () => {
    // 40 and 100 are both above the centre line of the pane at its top.
    const p = scrolled([['added', 40], ['changed', 100], ['added', 1000]]);
    stepChange(p, 'next');
    expect(p.scrollTop).toBe(centring(1000));
    stepChange(p, 'next'); // wraps to the first: the pane goes to the top, and can't centre it
    expect(p.scrollTop).toBe(0);
    stepChange(p, 'next'); // 100, which the centre line alone would skip
    expect(p.scrollTop).toBe(0);
    stepChange(p, 'next');
    expect(p.scrollTop).toBe(centring(1000));
    stepChange(p, 'previous');
    stepChange(p, 'previous');
    expect(p.scrollTop).toBe(0);
  });

  it('holds one stepper; a removal only removes its own', () => {
    const a = () => {};
    const b = () => {};
    const offA = setChangeStepper(a);
    const offB = setChangeStepper(b);
    offA();
    expect(changeStepper()).toBe(b);
    offB();
    expect(changeStepper()).toBeNull();
  });
});
