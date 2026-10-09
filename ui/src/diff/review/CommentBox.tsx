import { useRef, useState } from 'react';
import type { ReviewAnchor } from '../../api/gen/ReviewAnchor';
import { clearDraft, draftKey, setDraft, useReplyDrafts } from '../../forge/mrview/drafts';
import { addToReview, commentNow, useReview } from '../../forge/review/session';
import { MarkdownField } from '../../markdown/MarkdownField';
import { registerKeyHints } from '../../shortcuts/hints';
import { currentOrigin, type Origin } from '../../ui/arm/origin';
import { confirmAction } from '../../ui/ConfirmDialog';
import { HoverTooltip } from '../../ui/HoverTooltip';
import { boxKey } from './store';
import { suggestionBlock } from './mode';
import './review.css';

export const NO_SUGGESTION = 'Suggestions are for the new side’s lines';
/** Add to review's answer where drafts can't be kept (GitLab before 16.3; Plan 1's `canDraft`). */
export const NO_DRAFTS = 'This GitLab keeps no pending comments (16.3 or later does): use Comment now';
/** A control as a key's origin: a confirm arms it in place (spec §ui confirms). */
const keyOrigin = (el: HTMLElement): Origin => ({ el, rect: null, via: 'key', control: true, holds: 0 });

/**
 * A new comment under lines of the MR's diff (spec 2026-10-08 §2): the Markdown composer (emoji and
 * @ completion), then Cancel, Suggest change, Comment now and Add to review (the default, Mod+Enter).
 * The text is the MR view's reply draft for this anchor, so it outlives the box being laid out again.
 * A write the forge refuses keeps the text and shows the reason (§7). Cancel, or Esc in the field,
 * arms first when there's text. `disabledReason`: why neither send can go now (a stale Compare).
 * `autoFocus` (default true): the field takes the keyboard when the box mounts; false for a box
 * laid out again (a tab shown again), which mustn't take it from where the user is.
 */
export function CommentBox({ tabId, anchor, suggestion, onDone, onCancel, disabledReason = null, autoFocus = true }: {
  tabId: string;
  anchor: ReviewAnchor;
  suggestion?: string;
  onDone: () => void;
  onCancel: () => void;
  disabledReason?: string | null;
  autoFocus?: boolean;
}) {
  const review = useReview(tabId);
  const kind = review?.kind ?? 'gitlab';
  const key = draftKey(tabId, review?.number ?? -1, `review:${boxKey(anchor)}`);
  const text = useReplyDrafts((s) => s.text[key] ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const empty = text.trim() === '';
  const canDraft = review?.canDraft ?? true;
  const blocked = disabledReason !== null;
  const send = async (how: 'add' | 'now') => {
    if (empty || busy || blocked) return;
    if (how === 'add' && !canDraft) return setError(NO_DRAFTS);
    setBusy(true);
    setError(null);
    const out = how === 'add' ? await addToReview(tabId, anchor, text) : await commentNow(tabId, anchor, text);
    setBusy(false);
    if (!out.ok) return setError(out.error);
    clearDraft(key);
    onDone();
  };
  /** `from`: where the keyboard was (Esc in the field or its preview), to go back to. */
  const cancel = async (origin: Origin | null, from: HTMLElement | null = null) => {
    if (!empty && !(await confirmAction({ title: 'Discard this comment?', confirmLabel: 'Discard', arm: 'Click again to discard the comment', danger: true }, origin))) {
      // Disarmed (Esc, or a press elsewhere): back to writing, unless the keyboard went elsewhere.
      const now = document.activeElement;
      if (now === null || now === document.body || now === cancelButton.current) (from?.isConnected ? from : form.current?.querySelector<HTMLElement>('.md-field-preview, textarea'))?.focus();
      return;
    }
    clearDraft(key);
    onCancel();
  };
  const suggest = () => {
    if (suggestion === undefined) return;
    const block = suggestionBlock(kind, suggestion.split('\n'));
    setDraft(key, empty ? block : `${text.trimEnd()}\n\n${block}`);
  };
  const reason = error ?? disabledReason;
  return (
    <form ref={form} className="review-card review-box" data-owns-escape="" aria-label="New comment" aria-busy={busy || undefined} onSubmit={(e) => { e.preventDefault(); void send('add'); }}>
      <MarkdownField
        label="Comment"
        placeholder="Leave a comment"
        value={text}
        onChange={(v) => setDraft(key, v)}
        flavor={kind}
        context={{ kind: 'forge', tabId }}
        autoFocus={autoFocus}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
            e.preventDefault();
            void send('add');
          } else if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
            e.preventDefault();
            const b = cancelButton.current;
            const from = e.currentTarget;
            // The confirm arms the Cancel button in place: it takes the focus first, so Enter
            // confirms, and Esc or a click elsewhere keeps writing.
            b?.focus();
            void cancel(b ? keyOrigin(b) : null, from);
          }
        }}
      />
      {reason && <p role="alert" className="review-error">{reason}</p>}
      <div className="mr-form-row">
        <button ref={cancelButton} type="button" className="mr-button" onClick={() => void cancel(currentOrigin())}>Cancel</button>
        {/* Unavailable, it stays hoverable (aria-disabled, not disabled) so its tooltip says why. */}
        <HoverTooltip content={NO_SUGGESTION} disabled={suggestion !== undefined}>
          <button type="button" className="mr-button" disabled={busy} aria-disabled={suggestion === undefined || undefined} onClick={suggest}>Suggest change</button>
        </HoverTooltip>
        <button type="button" className="mr-button" disabled={empty || busy || blocked} onClick={() => void send('now')}>Comment now</button>
        <button type="submit" className="mr-button primary" disabled={empty || busy || blocked} aria-disabled={!canDraft || undefined}>Add to review</button>
      </div>
    </form>
  );
}

// Shown in the Keyboard Shortcuts panel (Ctrl+/); metadata only.
registerKeyHints([
  { id: 'key.reviewAdd', section: 'Merge request', label: 'Add the comment to your review', keys: ['Mod+Enter'], context: '(when writing a comment in the diff)', source: 'diff/review/CommentBox.tsx' },
  { id: 'key.reviewCancel', section: 'Merge request', label: 'Cancel the comment (arms first when it has text)', keys: ['Esc'], context: '(when writing a comment in the diff)', source: 'diff/review/CommentBox.tsx' },
]);
