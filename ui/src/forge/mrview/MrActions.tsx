import { retryNote, retryPlan, type Sent } from '../review/retry';
import { Bell, BellOff, Check, ChevronDown, CircleCheck, EllipsisVertical, Link, Loader2, MessageSquareWarning, Pencil, GitPullRequestDraft, GitPullRequest } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useLend } from '../../app/lent';
import { api } from '../../api/client';
import { copyText } from '../../api/transport';
import { openMenuAt } from '../../menu/menuStore';
import type { MenuRow } from '../../menu/types';
import type { ForgeKind } from '../../api/gen/ForgeKind';
import type { ForgeMr } from '../../api/gen/ForgeMr';
import type { ForgeMrDetail } from '../../api/gen/ForgeMrDetail';
import type { ReviewEvent } from '../../api/gen/ReviewEvent';
import { currentOrigin } from '../../ui/arm/origin';
import { confirmAction } from '../../ui/ConfirmDialog';
import { HoverTooltip } from '../../ui/HoverTooltip';
import { useToast } from '../../ui/toastStore';
import { registerKeyHints } from '../../shortcuts/hints';
import { forgeName, mrRef } from '../labels';
import { useForge } from '../mrStore';
import { EditMr } from './EditMr';
import { forgeWrite, setMrSubscribed, toggleMrDraft } from './writes';
import { resumeReview, submitReview, useReview } from '../review/session';
import { clearDraft, draftKey, setDraft, useReplyDrafts } from './drafts';

/** What Request changes does on GitLab (said in the composer): its REST API has no review state;
 * newer servers' GraphQL sets the reviewer's (`mergeRequestRequestChanges`). */
const GITLAB_CHANGES_NOTE = 'Posts your comment and withdraws your approval; a GitLab with review states also marks your review Changes requested';

const REVIEW_MODES: Array<{ event: ReviewEvent; label: string; placeholder: string }> = [
  { event: 'comment', label: 'Comment', placeholder: 'Leave a comment' },
  { event: 'approve', label: 'Approve', placeholder: 'A comment with your approval (optional)' },
  { event: 'requestChanges', label: 'Request changes', placeholder: 'What should change?' },
];

/** The forge took the pending comments, then refused a later write (the approval, the summary,
 * Request changes: GitLab's are separate calls, and which one failed isn't known): what went in. */
/** What a review that went in says (the toast): `published`, the pending comments it sent with
 * it (null: none were pending). `fallback`: a GitLab with no Changes requested state took Request
 * changes as a comment and a withdrawn approval. */
export function reviewSaid(event: ReviewEvent, ref: string, fallback: boolean, published: number | null): string {
  const sent = published ? (published === 1 ? '1 comment' : `${published} comments`) : null;
  if (event === 'comment') return sent ? `Sent your review of ${ref} with ${sent}` : `Commented on ${ref}`;
  const and = sent ? `Published ${sent} and ` : '';
  if (event === 'approve') return sent ? `${and}approved ${ref}` : `Approved ${ref}`;
  if (fallback) return `${sent ? `${and}commented` : 'Commented'} on ${ref}. This GitLab has no Changes requested state, so your approval was withdrawn instead.`;
  return sent ? `${and}requested changes on ${ref}` : `Requested changes on ${ref}`;
}

export function partialText(kind: ForgeKind, published: number, error: string): string {
  const went = published === 0 ? 'Your pending review was published' : published === 1 ? 'Your comment was published' : `Your ${published} comments were published`;
  return `${went}, but ${forgeName(kind)} refused the rest: ${error}`;
}

/**
 * The review composer ("Review…", as GitHub's review dialog): Comment, Approve or Request
 * changes, and a message, optional to approve. The submit names the mode. One write (GitHub: one
 * review; GitLab: the note, the approval, the reviewer state). Ctrl+Enter submits. With a review
 * pending in the tab's session (spec 2026-10-08 §4), it sends the pending comments with it
 * (`submitReview`), the message optional then; if the forge took the comments but refused the
 * event, it stays open, says what went through, and keeps the message for another try (§7).
 * The message is kept as a draft until it's sent (`drafts.ts`); Cancel drops it. The top bar's
 * Submit review… shows it too (`SubmitPopover`).
 */
export function ReviewComposer({ tabId, kind, number, onDone }: { tabId: string; kind: ForgeKind; number: number; onDone: () => void }) {
  const [event, setEvent] = useState<ReviewEvent>('comment');
  const key = draftKey(tabId, number, 'review');
  const text = useReplyDrafts((s) => s.text[key] ?? '');
  const [busy, setBusy] = useState(false);
  const [partial, setPartial] = useState<string | null>(null);
  // What the last part-way answer said already went in: a retry skips it (`retryPlan`).
  const [sent, setSent] = useState<Sent | null>(null);
  // Unmounted under a send (the MR view's Review… pressed again): a part-way result is a toast then.
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const session = useReview(tabId);
  // A review left pending outside the session (`resumeReview`; the MR view's open reads it too).
  useEffect(() => { void resumeReview(tabId, number); }, [tabId, number]);
  const mine = session?.number === number ? session : null;
  const pending = mine?.drafts.length ?? 0;
  const withPending = pending > 0 || (mine?.pendingReview ?? null) !== null;
  const ref = mrRef(kind, number);
  const mode = REVIEW_MODES.find((m) => m.event === event)!;
  const ready = !busy && (event === 'approve' || text.trim() !== '' || pending > 0);
  const failure = event === 'comment' ? `Couldn't comment on ${ref}` : event === 'approve' ? `Couldn't approve ${ref}` : `Couldn't request changes on ${ref}`;
  const done = (message: string) => { clearDraft(key); useToast.getState().show(message); onDone(); };
  const cancel = () => { clearDraft(key); onDone(); };
  const send = async () => {
    setBusy(true);
    setPartial(null);
    const plan = retryPlan(event, text, sent);
    if (withPending) {
      const out = await submitReview(tabId, plan);
      setBusy(false);
      if (!out.ok) return void useToast.getState().show(`${failure}: ${out.error}`, { error: true });
      if (out.value.eventError) {
        const now = { bodyPosted: out.value.bodyPosted || !!sent?.bodyPosted, eventSent: out.value.eventSent || !!sent?.eventSent };
        const said = partialText(kind, out.value.published, out.value.eventError) + retryNote(now);
        setSent(now);
        return live.current ? setPartial(said) : void useToast.getState().show(said, { error: true });
      }
      return done(reviewSaid(event, ref, out.value.fallback, out.value.published));
    }
    const out = await forgeWrite(tabId, failure, (repo) => api.forgeReview(repo, number, plan));
    setBusy(false);
    if (out) done(reviewSaid(event, ref, out.value.fallback, null));
  };
  const placeholder = pending > 0 && event !== 'approve' ? 'A summary (optional)' : mode.placeholder;
  return (
    <form className="mr-reply mr-review" aria-label="Review" aria-busy={busy || undefined} onSubmit={(e) => { e.preventDefault(); if (ready) void send(); }}>
      <div className="mr-review-modes" role="radiogroup" aria-label="Review as">
        {REVIEW_MODES.map((m) => (
          <label key={m.event} className="mr-review-mode" data-event={m.event}>
            <input type="radio" name={`review-${number}`} value={m.event} checked={event === m.event} disabled={busy} onChange={() => { setEvent(m.event); setSent(null); }} />
            {m.label}
          </label>
        ))}
      </div>
      <textarea
        aria-label="Message"
        placeholder={placeholder}
        value={text}
        autoFocus
        onChange={(e) => setDraft(key, e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (ready) void send(); } }}
      />
      {withPending && <p className="mr-form-note">{pending === 0 ? `Sends your pending review on ${forgeName(kind)}` : `Sends your ${pending === 1 ? 'pending comment' : `${pending} pending comments`} with it`}</p>}
      {kind === 'gitlab' && event === 'requestChanges' && <p className="mr-form-note">{GITLAB_CHANGES_NOTE}</p>}
      {partial && <p role="alert" className="mr-form-note">{partial}</p>}
      <div className="mr-form-row">
        <button type="button" className="mr-button" onClick={cancel}>Cancel</button>
        <button type="submit" className={`mr-button primary${event === 'requestChanges' ? ' warn' : ''}`} disabled={!ready}>{busy ? 'Sending…' : mode.label}</button>
      </div>
    </form>
  );
}

export type MrMode = 'none' | 'review' | 'edit';

/** The MR/PR view's actions' shared state: which form is open (Request changes, Edit) and which
 * write runs. Its controls are in two places (`ReviewButtons` in the APPROVALS box,
 * `StatusActions` on the status line); its forms open under the header (`MrForms`). */
export interface MrActionsState {
  mode: MrMode;
  setMode(m: MrMode, focus?: 'title' | 'labels'): void;
  /** What Edit opens focused: the title, or (from the Labels card's pencil) the Labels picker. */
  editFocus: 'title' | 'labels';
  busy: 'approve' | 'draft' | null;
  /** Open or draft: the review actions, Edit and draft ⇄ ready apply. */
  live: boolean;
  approvedByMe: boolean;
  /** Arms in place; approves on the second click. */
  approve(): void;
  /** The ⋯ menu's rows. */
  rows(): MenuRow[];
}

export function useMrActions(tabId: string, kind: ForgeKind, mr: ForgeMr, detail: ForgeMrDetail | null): MrActionsState {
  const me = useForge((s) => s.byTab[tabId]?.me ?? null);
  const [mode, setModeState] = useState<MrMode>('none');
  const [editFocus, setEditFocus] = useState<'title' | 'labels'>('title');
  const setMode = (m: MrMode, focus: 'title' | 'labels' = 'title') => { setEditFocus(focus); setModeState(m); };
  const [busy, setBusy] = useState<'approve' | 'draft' | null>(null);
  const live = mr.state === 'open' || mr.state === 'draft';
  const ref = mrRef(kind, mr.number);
  const approvedByMe = me !== null && (detail?.mr.review.reviews ?? []).some((r) => r.user.username === me && r.state === 'approved');
  const approve = async () => {
    const origin = currentOrigin();
    if (!(await confirmAction({ title: `Approve ${ref}?`, confirmLabel: 'Approve', arm: 'Click again to approve', tone: 'positive' }, origin))) return;
    setBusy('approve');
    const out = await forgeWrite(tabId, `Couldn't approve ${ref}`, (repo) => api.forgeApprove(repo, mr.number));
    setBusy(null);
    if (!out) return;
    useToast.getState().show(`Approved ${ref}`);
  };
  const toggleDraft = async () => {
    setBusy('draft');
    await toggleMrDraft(tabId, kind, mr);
    setBusy(null);
  };
  // The forge's notifications for the token's user; unknown (the forge didn't say): no row.
  const subscribed = detail?.subscribed ?? null;
  const rows = (): MenuRow[] => [
    ...(live ? [{ kind: 'action' as const, id: 'mr.draft', label: mr.state === 'draft' ? 'Mark as ready' : 'Mark as draft', icon: mr.state === 'draft' ? GitPullRequest : GitPullRequestDraft, tooltip: mr.state === 'draft' ? `Mark ${ref} as ready for review` : `Mark ${ref} as a draft`, run: () => void toggleDraft() }] : []),
    ...(subscribed === null ? [] : [{
      kind: 'action' as const, id: 'mr.subscribe', label: subscribed ? 'Unsubscribe' : 'Subscribe', icon: subscribed ? BellOff : Bell,
      tooltip: subscribed ? `Stop getting ${forgeName(kind)}'s notifications about ${ref}` : `Get ${forgeName(kind)}'s notifications about ${ref} (email and in-app)`,
      run: () => void setMrSubscribed(tabId, kind, mr.number, !subscribed),
    }]),
    { kind: 'action', id: 'mr.copyLink', label: 'Copy link', icon: Link, tooltip: `Copy ${ref}'s web address`, run: () => { copyText(mr.webUrl).then(() => useToast.getState().show('Copied the link'), () => useToast.getState().show("Couldn't copy the link", { error: true })); } },
  ];
  // Ctrl+Shift+A (`keyActions.ts`), while the button would take a click.
  useLend('mr.approve', tabId, live && !approvedByMe && busy === null ? () => void approve() : null);
  return { mode, setMode, editFocus, busy, live, approvedByMe, approve: () => void approve(), rows };
}

/** Approve (a green check) and Review… (an orange bubble with a caret): small icon buttons at the
 * top right of the APPROVALS box, for open and draft MRs/PRs only. Approve arms in place first;
 * Review… opens the review composer (Comment, Approve, Request changes): it prompts rather than
 * acts, so its caret, as every card button that opens something. */
export function ReviewButtons({ kind, mr, actions: a }: { kind: ForgeKind; mr: ForgeMr; actions: MrActionsState }) {
  if (!a.live) return null;
  const ref = mrRef(kind, mr.number);
  return (
    <span className="mr-review-buttons" role="group" aria-label="Review" data-arm-grow="left">
      <HoverTooltip content={a.approvedByMe ? `You approved ${ref}` : `Approve ${ref}`}>
        <button type="button" className="card-btn approve" data-on={a.approvedByMe || undefined} aria-label={a.approvedByMe ? 'Approved' : 'Approve'} aria-busy={a.busy === 'approve'} disabled={a.approvedByMe || a.busy !== null} onClick={a.approve}>
          {a.busy === 'approve' ? <Loader2 className="spin" size={13} aria-hidden /> : a.approvedByMe ? <CircleCheck size={13} aria-hidden /> : <Check size={13} aria-hidden />}
        </button>
      </HoverTooltip>
      <HoverTooltip content={`Review ${ref}: comment, approve or request changes`}>
        <button type="button" className="card-btn changes prompts" aria-label="Review…" aria-haspopup="dialog" aria-expanded={a.mode === 'review'} disabled={a.busy !== null} onClick={() => a.setMode(a.mode === 'review' ? 'none' : 'review')}>
          <MessageSquareWarning size={13} aria-hidden /><ChevronDown className="card-caret" size={9} aria-hidden />
        </button>
      </HoverTooltip>
    </span>
  );
}

/** Check out (`children`), Edit and the ⋯ menu, at the right end of the status line (spec #4 §4
 * "4B"). Edit and draft ⇄ ready are for open and draft MRs/PRs only; Check out and Copy link stay
 * on a merged or closed one. */
export function StatusActions({ actions: a, children }: { actions: MrActionsState; children?: ReactNode }) {
  const more = useRef<HTMLButtonElement>(null);
  return (
    <span className="mr-actions" role="group" aria-label="Actions">
      {children}
      {a.live && <button type="button" className="mr-button" aria-expanded={a.mode === 'edit'} disabled={a.busy !== null} onClick={() => a.setMode(a.mode === 'edit' ? 'none' : 'edit')}><Pencil size={13} aria-hidden /> Edit</button>}
      <button ref={more} type="button" className="mr-button icon" aria-label="More actions" aria-haspopup="menu" disabled={a.busy !== null} onClick={() => { if (more.current) openMenuAt(more.current, a.rows(), undefined, a.rows, 'More actions'); }}><EllipsisVertical size={14} aria-hidden /></button>
    </span>
  );
}

/** The Request changes composer or the Edit form, under the header. */
export function MrForms({ tabId, kind, mr, detail, actions: a }: { tabId: string; kind: ForgeKind; mr: ForgeMr; detail: ForgeMrDetail | null; actions: MrActionsState }) {
  if (!a.live) return null;
  if (a.mode === 'review') return <ReviewComposer tabId={tabId} kind={kind} number={mr.number} onDone={() => a.setMode('none')} />;
  if (a.mode === 'edit') return <EditMr tabId={tabId} mr={mr} detail={detail} focus={a.editFocus} onDone={() => a.setMode('none')} />;
  return null;
}

// Shown in the Keyboard Shortcuts panel (Ctrl+/); metadata only.
registerKeyHints([
  { id: 'key.mrReview', section: 'Merge request', label: 'Submit the review (Comment, Approve or Request changes)', keys: ['Mod+Enter'], context: '(in the review composer)', source: 'forge/mrview/MrActions.tsx' },
]);
