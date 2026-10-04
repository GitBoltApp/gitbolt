import { useState } from 'react';
import { api } from '../../api/client';
import type { ForgeKind } from '../../api/gen/ForgeKind';
import type { ForgeMr } from '../../api/gen/ForgeMr';
import type { ForgeMrDetail } from '../../api/gen/ForgeMrDetail';
import { HoverTooltip } from '../../ui/HoverTooltip';
import { useToast } from '../../ui/toast';
import { mrRef } from '../labels';
import { useForge } from '../mrStore';
import { EditMr } from './EditMr';
import { forgeWrite, putMr } from './writes';

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

/** Approve, request changes, edit, draft ⇄ ready (spec #4 §4 "4B"): open and draft MRs/PRs only. */
export function MrActions({ tabId, kind, mr, detail }: { tabId: string; kind: ForgeKind; mr: ForgeMr; detail: ForgeMrDetail | null }) {
  const me = useForge((s) => s.byTab[tabId]?.me ?? null);
  const [mode, setMode] = useState<'none' | 'changes' | 'edit'>('none');
  const [busy, setBusy] = useState<'approve' | 'draft' | null>(null);
  if (mr.state !== 'open' && mr.state !== 'draft') return null;
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
    const draft = mr.state !== 'draft';
    setBusy('draft');
    const out = await forgeWrite(tabId, draft ? `Couldn't mark ${ref} as a draft` : `Couldn't mark ${ref} as ready`, (repo) => api.forgeSetDraft(repo, mr.number, draft));
    setBusy(null);
    if (out) putMr(tabId, out.value);
  };
  return (
    <>
      <div className="mr-actions" role="group" aria-label="Actions">
        <button type="button" className="mr-button" disabled={approvedByMe || busy !== null} onClick={() => void approve()}>
          {busy === 'approve' ? 'Approving…' : approvedByMe ? 'You approved it' : 'Approve'}
        </button>
        <HoverTooltip content={CHANGES_TIP[kind]}>
          <button type="button" className="mr-button" aria-expanded={mode === 'changes'} disabled={busy !== null} onClick={() => setMode(mode === 'changes' ? 'none' : 'changes')}>Request changes</button>
        </HoverTooltip>
        <button type="button" className="mr-button" aria-expanded={mode === 'edit'} disabled={busy !== null} onClick={() => setMode(mode === 'edit' ? 'none' : 'edit')}>Edit</button>
        <button type="button" className="mr-button" disabled={busy !== null} onClick={() => void toggleDraft()}>
          {busy === 'draft' ? 'Saving…' : mr.state === 'draft' ? 'Mark as ready' : 'Mark as draft'}
        </button>
      </div>
      {mode === 'changes' && <RequestChanges tabId={tabId} kind={kind} mr={mr} onDone={() => setMode('none')} />}
      {mode === 'edit' && <EditMr tabId={tabId} mr={mr} detail={detail} onDone={() => setMode('none')} />}
    </>
  );
}
