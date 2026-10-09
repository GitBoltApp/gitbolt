import type { PlacedItem } from '../../forge/review/model';
import { CommentBox } from './CommentBox';
import { DraftCard } from './DraftCard';
import type { OpenBox } from './store';
import { ThreadCard } from './ThreadCard';

/**
 * A rendered diff's block slot in review mode (`RenderedReview`): its threads, drafts and open
 * comment boxes. A module of its own, loaded once a review shows, so the plain rendered diff
 * doesn't take in the cards and the MR view's thread and composer. `fresh`: the box just opened,
 * which takes the keyboard when it mounts; `onFocus`: a box took the keyboard; `disabledReason`:
 * why the boxes can't send now (a stale Compare); `onLeave`: the keyboard back to the diff (a
 * deleted draft held it).
 */
export function RenderedCards({ tabId, items, boxes, fresh, disabledReason, onClose, onFocus, onLeave }: { tabId: string; items: readonly PlacedItem[]; boxes: readonly OpenBox[]; fresh: string | null; disabledReason: string | null; onClose: (key: string) => void; onFocus: (key: string) => void; onLeave: () => void }) {
  return (
    <>
      {items.map((it) => (it.kind === 'thread'
        ? <ThreadCard key={`t:${it.thread.id}`} tabId={tabId} thread={it.thread} outdated={it.at.outdated} />
        : <DraftCard key={`d:${it.draft.id}`} tabId={tabId} draft={it.draft} outdated={it.at.outdated} onGone={onLeave} />))}
      {boxes.map((b) => (
        <div key={b.key} data-box-key={b.key} onFocus={() => onFocus(b.key)}>
          <CommentBox tabId={tabId} anchor={b.anchor} suggestion={b.suggestion} disabledReason={disabledReason} autoFocus={fresh === b.key} onDone={() => onClose(b.key)} onCancel={() => onClose(b.key)} />
        </div>
      ))}
    </>
  );
}
