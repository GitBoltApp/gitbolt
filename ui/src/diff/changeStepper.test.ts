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

  it('steps by position even when targets come out of order (a split row: new side first)', () => {
    const p = pane([['added', 300], ['removed', 40]]);
    stepChange(p, 'next');
    expect(p.scrollTop).toBe(40 - STEP_MARGIN);
  });

  it('steps to the next change below the top edge, and the previous one above it', () => {
    const p = pane([[null, 0], ['added', 40], [null, 200], ['changed', 300]]);
    expect(stepChange(p, 'next')).toBe(true);
    expect(p.scrollTop).toBe(40 - STEP_MARGIN);
    const q = pane([['added', -300], [null, -100], ['changed', -50], [null, 10]]);
    expect(stepChange(q, 'previous')).toBe(true);
    expect(q.scrollTop).toBe(-50 - STEP_MARGIN);
  });

  it('wraps: past the last change to the first, before the first to the last', () => {
    const p = pane([['added', -300], [null, 0], ['changed', -50]]);
    expect(stepChange(p, 'next')).toBe(true);
    expect(p.scrollTop).toBe(-300 - STEP_MARGIN);
    const q = pane([[null, 0], ['added', 40], ['changed', 300]]);
    expect(stepChange(q, 'previous')).toBe(true);
    expect(q.scrollTop).toBe(300 - STEP_MARGIN);
    expect(stepChange(pane([[null, 0]]), 'next')).toBe(false);
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
