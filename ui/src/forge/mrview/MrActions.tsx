import { Check, CircleCheck, EllipsisVertical, Link, Loader2, MessageSquareWarning, Pencil, GitPullRequestDraft, GitPullRequest } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import { api } from '../../api/client';
import { copyText } from '../../api/transport';
import { openMenuAt } from '../../menu/menuStore';
import type { MenuRow } from '../../menu/types';
import type { ForgeKind } from '../../api/gen/ForgeKind';
import type { ForgeMr } from '../../api/gen/ForgeMr';
import type { ForgeMrDetail } from '../../api/gen/ForgeMrDetail';
import { currentOrigin } from '../../ui/arm/origin';
import { confirmAction } from '../../ui/ConfirmDialog';
import { HoverTooltip } from '../../ui/HoverTooltip';
import { useToast } from '../../ui/toast';
import { mrRef } from '../labels';
import { useForge } from '../mrStore';
import { EditMr } from './EditMr';
import { forgeWrite, toggleMrDraft } from './writes';

/** What Request changes does on GitLab, whose API has no review state (said in its composer). */
const GITLAB_CHANGES_NOTE = "Posts your comment and withdraws your approval: GitLab's API has no review state";

function RequestChanges({ tabId, kind, mr, onDone }: { tabId: string; kind: ForgeKind; mr: ForgeMr; onDone: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = mrRef(kind, mr.number);
  const send = async () => {
    setBusy(true);
    const out = await forgeWrite(tabId, `Couldn't request changes on ${ref}`, (repo) => api.forgeRequestChanges(repo, mr.number, text));
    setBusy(false);
    if (!out) return;
    useToast.getState().show(`Requested changes on ${ref}`);
    onDone();
  };
  return (
    <form className="mr-reply" aria-label="Request changes" onSubmit={(e) => { e.preventDefault(); if (text.trim() && !busy) void send(); }}>
      <textarea aria-label="What should change?" placeholder="What should change?" value={text} onChange={(e) => setText(e.target.value)} />
      {kind === 'gitlab' && <p className="mr-form-note">{GITLAB_CHANGES_NOTE}</p>}
      <div className="mr-form-row">
        <button type="button" className="mr-button" onClick={onDone}>Cancel</button>
        <button type="submit" className="mr-button primary" disabled={!text.trim() || busy}>{busy ? 'Sending…' : 'Request changes'}</button>
      </div>
    </form>
  );
}

export type MrMode = 'none' | 'changes' | 'edit';

/** The MR/PR view's actions' shared state: which form is open (Request changes, Edit) and which
 * write runs. Its controls are in two places (`ReviewButtons` in the APPROVALS box,
 * `StatusActions` on the status line); its forms open under the header (`MrForms`). */
export interface MrActionsState {
  mode: MrMode;
  setMode(m: MrMode): void;
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
  const [mode, setMode] = useState<MrMode>('none');
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
  const rows = (): MenuRow[] => [
    ...(live ? [{ kind: 'action' as const, id: 'mr.draft', label: mr.state === 'draft' ? 'Mark as ready' : 'Mark as draft', icon: mr.state === 'draft' ? GitPullRequest : GitPullRequestDraft, tooltip: mr.state === 'draft' ? `Mark ${ref} as ready for review` : `Mark ${ref} as a draft`, run: () => void toggleDraft() }] : []),
    { kind: 'action', id: 'mr.copyLink', label: 'Copy link', icon: Link, tooltip: `Copy ${ref}'s web address`, run: () => { copyText(mr.webUrl).then(() => useToast.getState().show('Copied the link'), () => useToast.getState().show("Couldn't copy the link", { error: true })); } },
  ];
  return { mode, setMode, busy, live, approvedByMe, approve: () => void approve(), rows };
}

/** Approve (a green check) and Request changes (an orange "!" bubble): small icon buttons at the
 * top right of the APPROVALS box, for open and draft MRs/PRs only. Approve arms in place first;
 * Request changes opens its composer (its own confirm step). */
export function ReviewButtons({ kind, mr, actions: a }: { kind: ForgeKind; mr: ForgeMr; actions: MrActionsState }) {
  if (!a.live) return null;
  const ref = mrRef(kind, mr.number);
  return (
    <span className="mr-review-buttons" role="group" aria-label="Review" data-arm-grow="left">
      <HoverTooltip content={a.approvedByMe ? `You approved ${ref}` : `Approve ${ref}`}>
        <button type="button" className="mr-review-btn approve" aria-label={a.approvedByMe ? 'Approved' : 'Approve'} aria-busy={a.busy === 'approve'} disabled={a.approvedByMe || a.busy !== null} onClick={a.approve}>
          {a.busy === 'approve' ? <Loader2 className="spin" size={13} aria-hidden /> : a.approvedByMe ? <CircleCheck size={13} aria-hidden /> : <Check size={13} aria-hidden />}
        </button>
      </HoverTooltip>
      <HoverTooltip content={`Request changes on ${ref}`}>
        <button type="button" className="mr-review-btn changes" aria-label="Request changes" aria-expanded={a.mode === 'changes'} disabled={a.busy !== null} onClick={() => a.setMode(a.mode === 'changes' ? 'none' : 'changes')}>
          <MessageSquareWarning size={13} aria-hidden />
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
  if (a.mode === 'changes') return <RequestChanges tabId={tabId} kind={kind} mr={mr} onDone={() => a.setMode('none')} />;
  if (a.mode === 'edit') return <EditMr tabId={tabId} mr={mr} detail={detail} onDone={() => a.setMode('none')} />;
  return null;
}
