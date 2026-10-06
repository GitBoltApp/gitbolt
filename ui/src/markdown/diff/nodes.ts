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

/** The split view's row (`split.ts`): the old side's cell, then the new side's, side by side.
 * `mark`: how the row changed (`null`: it didn't). `joined`: the next row continues the same list
 * or blockquote, so its container keeps no bottom margin. */
export interface SplitRowNode extends Parent { type: 'splitRow'; mark: DiffMark | null; joined?: true; children: [SplitCellNode, SplitCellNode] }
/** One side of a split row; `empty`: a placeholder for a block only the other side has. */
export interface SplitCellNode extends Parent { type: 'splitCell'; side: 'old' | 'new'; empty?: true; children: Array<BlockContent | DefinitionContent> }

declare module 'mdast' {
  interface RootContentMap { diffBlock: DiffBlockNode; diffPair: DiffPairNode; diffIns: DiffInsNode; diffDel: DiffDelNode; splitRow: SplitRowNode; splitCell: SplitCellNode }
  interface BlockContentMap { diffBlock: DiffBlockNode; diffPair: DiffPairNode }
  interface PhrasingContentMap { diffIns: DiffInsNode; diffDel: DiffDelNode }
  /** `gbValue`: an ordered list item's number in the rendered diff (R12). `gbOldValue` and
   * `gbOldChecked`: a kept or changed item's number and checkbox on the old side, where they
   * differ (the split view's old column; the one-column diff ignores them). */
  interface ListItemData { gbDiff?: DiffMark; gbValue?: number; gbOldValue?: number; gbOldChecked?: boolean | null }
  /** `gbEmpty`: the split view's placeholder for a row only the other side has. */
  interface TableRowData { gbDiff?: DiffMark; gbEmpty?: true }
  /** A changed code block's merged lines (R10): one of ' ', '-', '+' per line. `gbWords`: its
   * paired lines' changed words (diff/words.ts `codeLines`). */
  interface CodeData { gbLines?: string; gbWords?: string }
  /** The number of marked changes in a rendered diff (on its first chunk). */
  interface RootData { gbChanges?: number }
}
