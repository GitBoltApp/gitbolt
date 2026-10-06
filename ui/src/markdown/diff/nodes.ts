import type { BlockContent, DefinitionContent, Parent, PhrasingContent } from 'mdast';

/** How a block, list item or table row changed in a rendered diff (5C). */
export type DiffMark = 'added' | 'removed' | 'changed';

/** A block (or an HTML run) that was added, removed or changed: a marked `div` when rendered.
 * `note`: what changed, when nothing inside shows it (a list's start number, a table's alignment,
 * a code block's info string). */
export interface DiffBlockNode extends Parent { type: 'diffBlock'; mark: DiffMark; note?: string; children: Array<BlockContent | DefinitionContent> }
/** A changed diagram (R11): the removed block, then the added one, side by side. */
export interface DiffPairNode extends Parent { type: 'diffPair'; children: [DiffBlockNode, DiffBlockNode] }
/** Words added inside a changed block. */
export interface DiffInsNode extends Parent { type: 'diffIns'; children: PhrasingContent[] }
/** Words removed inside a changed block (they resolve links and images on the old side). */
export interface DiffDelNode extends Parent { type: 'diffDel'; children: PhrasingContent[] }

declare module 'mdast' {
  interface RootContentMap { diffBlock: DiffBlockNode; diffPair: DiffPairNode; diffIns: DiffInsNode; diffDel: DiffDelNode }
  interface BlockContentMap { diffBlock: DiffBlockNode; diffPair: DiffPairNode }
  interface PhrasingContentMap { diffIns: DiffInsNode; diffDel: DiffDelNode }
  /** `gbValue`: an ordered list item's number in the rendered diff (R12). */
  interface ListItemData { gbDiff?: DiffMark; gbValue?: number }
  interface TableRowData { gbDiff?: DiffMark }
  /** A changed code block's merged lines (R10): one of ' ', '-', '+' per line. */
  interface CodeData { gbLines?: string }
  /** The number of marked changes in a rendered diff (on its first chunk). */
  interface RootData { gbChanges?: number }
}
