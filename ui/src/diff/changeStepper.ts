import { revealTop, stepTarget, type StepDir } from './changeNav';

export type { StepDir };

/** Where a stepped-to change taller than the pane starts below its top edge, in px. */
export const STEP_MARGIN = 16;

let stepper: ((dir: StepDir) => void) | null = null;

/** 5C (R3): while a rendered Markdown diff shows, Previous/Next change and F7 step through its
 * changes instead of the (hidden) editor's. Returns its removal, which removes only this one. */
export function setChangeStepper(fn: (dir: StepDir) => void): () => void {
  stepper = fn;
  return () => { if (stepper === fn) stepper = null; };
}
export const changeStepper = () => stepper;

const outermost = (root: Element): HTMLElement[] =>
  [...root.querySelectorAll<HTMLElement>('[data-diff-mark]')].filter((el) => el.parentElement?.closest('[data-diff-mark]') === root.closest('[data-diff-mark]'));

/** A split row's own changes. A row that holds one marked block (a changed paragraph, code
 * block, diagram pair) or that one side only has is the change itself. A row that holds a
 * container whose rows or items carry their own marks (a table, a list) gives those: the new
 * side's (changed and added), then the old side's removed ones, as the rows are lined up. */
function rowTargets(row: HTMLElement): HTMLElement[] {
  const [old, neu] = [...row.children].filter((c) => c.classList.contains('md-split-cell'));
  if (!old || !neu) return [row];
  const whole = (cell: Element) => cell.children.length === 0 || [...cell.children].some((c) => c.hasAttribute('data-diff-mark'));
  if (whole(old) || whole(neu)) return [row];
  const inner = [...outermost(neu), ...outermost(old).filter((el) => el.dataset.diffMark === 'removed')];
  return inner.length > 0 ? inner : [row];
}

/** Each change in `pane`: a marked element (`data-diff-mark`) outside any other marked one, but a
 * split row's table rows or list items rather than the row (`rowTargets`), so a table with one
 * changed row is one change at that row. These are the changes the diff counts (`gbChanges`: each
 * marked node once, a diagram pair once), so a removed block followed by an added one is two
 * stops, as it's two changes. Within a split row, the order is the new side's then the old
 * side's: `stepChange` and the ruler go by position. */
export function changeTargets(pane: HTMLElement): HTMLElement[] {
  return outermost(pane).flatMap((el) => (el.classList.contains('md-split-row') ? rowTargets(el) : [el]));
}

/** The change each pane's last step put it on, and the scroll that left (`stepTarget`'s
 * `current`), while its changes are the same ones (`count`: a chunk rendering since adds more). */
const lastStep = new WeakMap<HTMLElement, { index: number; top: number; count: number }>();

/**
 * Scrolls `pane` to the next or previous change, as the diff editor's Next/Previous change do
 * (`stepTarget`): Next, the first change starting below the pane's centre line; Previous, the last
 * one ending above it; right after a step, on from the change it went to. The change is centred
 * (`revealTop`). Past the last change it wraps to the first, and before the first to the last.
 * False when there's no change at all. A large diff renders chunk by chunk (`StreamBody`): a
 * change in a chunk not rendered yet isn't in the pane, so stepping reaches it once its chunk has
 * rendered (a chunk per idle callback).
 */
export function stepChange(pane: HTMLElement, dir: StepDir): boolean {
  const origin = pane.getBoundingClientRect().top - pane.scrollTop;
  const boxes = changeTargets(pane).map((el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top - origin, bottom: r.bottom - origin };
  }).sort((a, b) => a.top - b.top);
  const last = lastStep.get(pane);
  const current = last && last.count === boxes.length && Math.abs(pane.scrollTop - last.top) <= 1 ? last.index : null;
  const i = stepTarget(boxes, { top: pane.scrollTop, height: pane.clientHeight }, dir, current);
  if (i === null) return false;
  pane.scrollTop = revealTop(boxes[i]!, pane.clientHeight, STEP_MARGIN);
  lastStep.set(pane, { index: i, top: pane.scrollTop, count: boxes.length });
  return true;
}
