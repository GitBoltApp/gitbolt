export type StepDir = 'next' | 'previous';

/** Where a stepped-to change sits below the pane's top edge, in px. */
export const STEP_MARGIN = 16;
const SLACK = 4;

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

/**
 * Scrolls `pane` so the next change below (or the previous one above) its top edge sits
 * STEP_MARGIN px under it. Past the last change it wraps to the first, and before the first to
 * the last, as the diff editor's Next/Previous change do. False when there's no change at all.
 * A large diff renders chunk by chunk (`StreamBody`): a change in a chunk not rendered yet isn't
 * in the pane, so stepping reaches it once its chunk has rendered (a chunk per idle callback).
 */
export function stepChange(pane: HTMLElement, dir: StepDir): boolean {
  const top = pane.getBoundingClientRect().top;
  const ys = changeTargets(pane).map((el) => el.getBoundingClientRect().top - top).sort((a, b) => a - b);
  if (ys.length === 0) return false;
  const y = dir === 'next'
    ? ys.find((v) => v > STEP_MARGIN + SLACK) ?? ys[0]!
    : [...ys].reverse().find((v) => v < STEP_MARGIN - SLACK) ?? ys.at(-1)!;
  pane.scrollTop += y - STEP_MARGIN;
  return true;
}
