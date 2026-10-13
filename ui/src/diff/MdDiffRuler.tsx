import type { ReactNode, RefObject } from 'react';
import { changeBox, changeTargets } from './changeStepper';
import { markKind, type RulerKind, type RulerMark } from './mdRuler';
import { RulerFrame } from './RulerFrame';

/** Each change the stepper counts (`changeTargets`, so the strip, the count and Previous/Next
 * agree), in the pane's content px. */
function changeMarks(el: HTMLElement): RulerMark[] {
  const origin = el.getBoundingClientRect().top - el.scrollTop;
  const marks: RulerMark[] = [];
  for (const t of changeTargets(el)) {
    const kind: RulerKind | null = markKind(t.dataset.diffMark);
    if (!kind) continue;
    const r = changeBox(t);
    marks.push({ top: r.top - origin, height: r.bottom - r.top, kind });
  }
  return marks;
}

/**
 * The rendered Markdown diff's box (`pane`) with its overview ruler (`RulerFrame`), as the Source
 * diff's Monaco overview. Not `active` (Source): no strip. Chunks stream in, diagrams draw and
 * images load inside the pane, so any change in it measures again.
 */
export function MdDiffFrame({ pane, active, split, children, after }: { pane: RefObject<HTMLElement | null>; active: boolean; split: boolean; children: ReactNode; after?: ReactNode }) {
  return <RulerFrame pane={pane} active={active} split={split} marks={changeMarks} watchContent after={after}>{children}</RulerFrame>;
}
