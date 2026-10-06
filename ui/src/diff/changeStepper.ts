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

/** Each change in `pane`: a marked element (`data-diff-mark`) outside any other marked one. These
 * are the changes the diff counts (`gbChanges`: each marked node once, a diagram pair once), so a
 * removed block followed by an added one is two stops, as it's two changes. */
export function changeTargets(pane: HTMLElement): HTMLElement[] {
  return [...pane.querySelectorAll<HTMLElement>('[data-diff-mark]')].filter((el) => !el.parentElement?.closest('[data-diff-mark]'));
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
  const ys = changeTargets(pane).map((el) => el.getBoundingClientRect().top - top);
  if (ys.length === 0) return false;
  const y = dir === 'next'
    ? ys.find((v) => v > STEP_MARGIN + SLACK) ?? ys[0]!
    : [...ys].reverse().find((v) => v < STEP_MARGIN - SLACK) ?? ys.at(-1)!;
  pane.scrollTop += y - STEP_MARGIN;
  return true;
}
