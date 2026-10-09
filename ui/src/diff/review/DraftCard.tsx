import { Pencil, Trash2 } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReviewDraft } from '../../api/gen/ReviewDraft';
import { escOwners } from '../../app/modalKeys';
import { clearDraft, draftKey, setDraft, useReplyDrafts } from '../../forge/mrview/drafts';
import { deleteDraft, editDraft, useReview } from '../../forge/review/session';
import { Markdown } from '../../markdown/lazy';
import { MR_BODY_MAX_BYTES } from '../../markdown/limits';
import { MarkdownField } from '../../markdown/MarkdownField';
import { registerKeyHints } from '../../shortcuts/hints';
import { currentOrigin } from '../../ui/arm/origin';
import { confirmAction } from '../../ui/ConfirmDialog';
import { HoverTooltip } from '../../ui/HoverTooltip';
import { useCardFocus } from './cardFocus';
import './review.css';

/**
 * One of the user's pending comments under its line (spec 2026-10-08 §2): a Pending mark (and
 * Outdated, at an older head), its text, Edit (the Markdown composer; Mod+Enter saves, Esc leaves)
 * and Delete, which arms in place first. A refused write keeps what's there and says why. The
 * edit closing hands the keyboard to Edit; the card deleted, to `onGone` (the diff).
 */
export function DraftCard({ tabId, draft, outdated, onGone }: { tabId: string; draft: ReviewDraft; outdated: boolean; onGone?: () => void }) {
  const review = useReview(tabId);
  const kind = review?.kind ?? 'gitlab';
  const context = useMemo(() => ({ kind: 'forge', tabId }) as const, [tabId]);
  /** The edit's text; null while not editing. In the MR view's reply drafts, so an edit outlives
   * the card being laid out again (a tab shown again). */
  const key = draftKey(tabId, review?.number ?? -1, `review-draft:${draft.id}`);
  const text = useReplyDrafts((s) => s.text[key] ?? null);
  const setText = (v: string | null) => (v === null ? clearDraft(key) : setDraft(key, v));
  /** The edit was just started here: its field takes the keyboard (not when laid out again). */
  const [started, setStarted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changed = text !== null && text.trim() !== '' && text !== draft.body;
  const form = useRef<HTMLFormElement>(null);
  // Inside a dialog (Submit review…, which lists the drafts on no line), Esc in the edit leaves
  // it, not the dialog.
  const editing = text !== null;
  useEffect(() => {
    if (!editing) return;
    const own = (e: KeyboardEvent) => {
      if (!(e.target instanceof Node && form.current?.contains(e.target))) return false;
      clearDraft(key);
      return true;
    };
    escOwners.add(own);
    return () => { escOwners.delete(own); };
  }, [editing, key]);
  const focus = useCardFocus();
  const editButton = useRef<HTMLButtonElement>(null);
  // Saved, cancelled or left with Esc: the keyboard goes back to Edit, not to the page.
  useLayoutEffect(() => {
    if (!editing && focus.dropped()) editButton.current?.focus({ preventScroll: true });
  }, [editing]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async () => {
    if (!changed || busy) return;
    setBusy(true);
    setError(null);
    const out = await editDraft(tabId, draft.id, text);
    setBusy(false);
    if (out.ok) setText(null);
    else setError(out.error);
  };
  const remove = async () => {
    if (!(await confirmAction({ title: 'Delete this pending comment?', confirmLabel: 'Delete', arm: 'Click again to delete the pending comment', danger: true }, currentOrigin()))) return;
    setBusy(true);
    setError(null);
    const out = await deleteDraft(tabId, draft.id);
    setBusy(false);
    if (!out.ok) return setError(out.error);
    // Once the card is gone (the session's next render), the keyboard it held goes to `onGone`.
    setTimeout(() => { if (focus.dropped()) onGone?.(); });
  };
  return (
    <article className="review-card review-draft" aria-label="Pending comment" aria-busy={busy || undefined} {...focus.props}>
      <div className="review-card-head">
        <span className="review-chip pending">Pending</span>
        {outdated && <span className="review-chip outdated">Outdated</span>}
        <span className="mr-spacer" />
        {text === null && (
          <>
            <HoverTooltip content="Edit"><button ref={editButton} type="button" className="review-icon" data-review-focus="" aria-label="Edit" onClick={() => { setError(null); setStarted(true); setText(draft.body); }}><Pencil size={14} aria-hidden /></button></HoverTooltip>
            <HoverTooltip content="Delete"><button type="button" className="review-icon" aria-label="Delete" onClick={() => { if (!busy) void remove(); }}><Trash2 size={14} aria-hidden /></button></HoverTooltip>
          </>
        )}
      </div>
      {text === null
        ? <div className="mr-note-body"><Markdown text={draft.body} flavor={kind} context={context} maxBytes={MR_BODY_MAX_BYTES} /></div>
        : (
          <form ref={form} className="mr-reply" aria-label="Edit pending comment" onSubmit={(e) => { e.preventDefault(); void save(); }}>
            <MarkdownField
              label="Edit pending comment"
              value={text}
              onChange={setText}
              flavor={kind}
              context={context}
              autoFocus={started}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  void save();
                } else if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
                  e.preventDefault();
                  setText(null);
                }
              }}
            />
            <div className="mr-form-row">
              <button type="button" className="mr-button" onClick={() => setText(null)}>Cancel</button>
              <button type="submit" className="mr-button primary" disabled={!changed || busy}>Save</button>
            </div>
          </form>
        )}
      {error && <p role="alert" className="review-error">{error}</p>}
    </article>
  );
}

// Shown in the Keyboard Shortcuts panel (Ctrl+/); metadata only.
registerKeyHints([
  { id: 'key.reviewDraftSave', section: 'Merge request', label: 'Save the edited pending comment', keys: ['Mod+Enter'], context: '(when editing a pending comment in the diff)', source: 'diff/review/DraftCard.tsx' },
  { id: 'key.reviewDraftCancel', section: 'Merge request', label: 'Leave the edit', keys: ['Esc'], context: '(when editing a pending comment in the diff)', source: 'diff/review/DraftCard.tsx' },
]);
