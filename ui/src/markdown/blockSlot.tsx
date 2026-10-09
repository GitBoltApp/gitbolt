import { createContext, useContext, type ReactNode } from 'react';

/** Which sides' lines a rendered block shows (a split view's column shows one side's). */
export interface SrcSides { new: boolean; old: boolean }

/** What shows under a rendered diff's block (review comments, spec 2026-10-08 §3): its threads,
 * drafts and comment boxes. Diff View provides it while the diff is a review's (`RenderedReview`);
 * elsewhere there's none, and blocks show nothing more. */
export interface BlockSlots { render(id: number, sides: SrcSides): ReactNode }

export const BlockSlotContext = createContext<BlockSlots | null>(null);

/** Under block `id`: what `BlockSlots` has for it, in a `data-review-slot` box (the change
 * stepper, the ruler and the block scan skip what's inside); nothing when it has nothing. */
export function BlockSlot({ id, sides }: { id: number; sides: SrcSides }) {
  const slots = useContext(BlockSlotContext);
  const content = slots?.render(id, sides);
  const empty = content == null || content === false || (Array.isArray(content) && content.length === 0);
  return empty ? null : <div className="md-block-slot" data-review-slot="">{content}</div>;
}
