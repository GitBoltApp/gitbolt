import { Check, EllipsisVertical, Link, MessageSquareWarning, Pencil, GitPullRequestDraft, GitPullRequest } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import { api } from '../../api/client';
import { copyText } from '../../api/transport';
import { openMenuAt } from '../../menu/menuStore';
import type { MenuRow } from '../../menu/types';
import type { ForgeKind } from '../../api/gen/ForgeKind';
import type { ForgeMr } from '../../api/gen/ForgeMr';
import type { ForgeMrDetail } from '../../api/gen/ForgeMrDetail';
import { HoverTooltip } from '../../ui/HoverTooltip';
import { useToast } from '../../ui/toast';
import { mrRef } from '../labels';
import { useForge } from '../mrStore';
import { EditMr } from './EditMr';
import { forgeWrite, toggleMrDraft } from './writes';

const CHANGES_TIP: Record<ForgeKind, string> = {
  gitlab: "Posts your comment and withdraws your approval: GitLab's API has no review state",
  github: 'Submits a review that requests changes',
};

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
      <div className="mr-form-row">
        <button type="button" className="mr-button" onClick={onDone}>Cancel</button>
        <button type="submit" className="mr-button primary" disabled={!text.trim() || busy}>{busy ? 'Sending…' : 'Request changes'}</button>
      </div>
    </form>
  );
}

/** Approve, request changes (left), Check out (`children`), Edit and the ⋯ menu (right; spec #4 §4
 * "4B"). Approve / request changes / edit / draft ⇄ ready are for open and draft MRs/PRs only;
 * Check out and Copy link stay on a merged or closed one. */
export function MrActions({ tabId, kind, mr, detail, children }: { tabId: string; kind: ForgeKind; mr: ForgeMr; detail: ForgeMrDetail | null; children?: ReactNode }) {
  const me = useForge((s) => s.byTab[tabId]?.me ?? null);
  const [mode, setMode] = useState<'none' | 'changes' | 'edit'>('none');
  const [busy, setBusy] = useState<'approve' | 'draft' | null>(null);
  const more = useRef<HTMLButtonElement>(null);
  const live = mr.state === 'open' || mr.state === 'draft';
  const ref = mrRef(kind, mr.number);
  const approvedByMe = me !== null && (detail?.mr.review.reviews ?? []).some((r) => r.user.username === me && r.state === 'approved');
  const approve = async () => {
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
  return (
    <>
      <div className="mr-actions" role="group" aria-label="Actions">
        {live && (
          <>
            <button type="button" className="mr-button approve" disabled={approvedByMe || busy !== null} onClick={() => void approve()}>
              {busy === 'approve' ? 'Approving…' : approvedByMe ? <><Check size={13} aria-hidden /> Approved</> : <><Check size={13} aria-hidden /> Approve</>}
            </button>
            <HoverTooltip content={CHANGES_TIP[kind]}>
              <button type="button" className="mr-button changes" aria-expanded={mode === 'changes'} disabled={busy !== null} onClick={() => setMode(mode === 'changes' ? 'none' : 'changes')}><MessageSquareWarning size={13} aria-hidden /> Request changes</button>
            </HoverTooltip>
          </>
        )}
        <span className="mr-spacer" />
        {children}
        {live && <button type="button" className="mr-button" aria-expanded={mode === 'edit'} disabled={busy !== null} onClick={() => setMode(mode === 'edit' ? 'none' : 'edit')}><Pencil size={13} aria-hidden /> Edit</button>}
        <button ref={more} type="button" className="mr-button icon" aria-label="More actions" aria-haspopup="menu" disabled={busy !== null} onClick={() => { if (more.current) openMenuAt(more.current, rows(), undefined, rows, 'More actions'); }}><EllipsisVertical size={14} aria-hidden /></button>
      </div>
      {live && mode === 'changes' && <RequestChanges tabId={tabId} kind={kind} mr={mr} onDone={() => setMode('none')} />}
      {live && mode === 'edit' && <EditMr tabId={tabId} mr={mr} detail={detail} onDone={() => setMode('none')} />}
    </>
  );
}
