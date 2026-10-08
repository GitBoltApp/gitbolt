import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { api, errorMessage } from '../../api/client';
import type { StackView } from '../../api/gen/StackView';
import { isTopModal, useModalKeys } from '../../app/modalKeys';
import { registerAppSlot } from '../../app/slots';
import { registerKeyHints } from '../../shortcuts/hints';
import type { Stack } from '../../stacks/detect';
import { useKeys } from '../../ui/keyRouter';
import { useToast } from '../../ui/toastStore';
import { writeCtx } from '../../write/ctx';
import { mrNoun, mrRef } from '../labels';
import { baseBranch, createSummary, memberPlans, runCreateStack, submitLabel, type MemberPlan } from './create';
import { forgeTarget } from './deps';
import './stack.css';
import { ArrowGlyph } from '../../ui/ArrowGlyph';

interface Req { tabId: string; stack: Stack }
const useDialog = create<{ req: Req | null }>(() => ({ req: null }));

/** "Create stack MRs…" (spec #4 §4 4D): a modal dialog (Ruling 6), not 4C's flyout. */
export const openCreateStack = (tabId: string, stack: Stack) => useDialog.setState({ req: { tabId, stack } });

export function CreateStackDialog() {
  const req = useDialog((s) => s.req);
  if (!req) return null;
  return <Form req={req} key={`${req.tabId}:${req.stack.branches.join(',')}`} />;
}

function Form({ req }: { req: Req }) {
  const [view, setView] = useState<StackView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState(false);
  const busy = useRef(false);
  const close = () => useDialog.setState({ req: null });
  const ref = useModalKeys<HTMLDivElement>(true, close);
  useEffect(() => {
    const ctx = writeCtx(req.tabId);
    const target = forgeTarget(req.tabId);
    if (!ctx || !target) { setError('This repository has no forge project: add an account in Settings › Accounts'); return; }
    let live = true;
    api.forgeStack(ctx.repoId, req.stack.branches, baseBranch(req.stack.base, target.remote), req.stack.base).then(
      (v) => { if (live) setView(v); },
      (e) => { if (live) setError(errorMessage(e)); },
    );
    return () => { live = false; };
  }, [req]);
  const kind = view?.kind ?? forgeTarget(req.tabId)?.kind ?? 'gitlab';
  const noun = mrNoun(kind);
  const plans = view ? memberPlans(view) : [];
  const titleOf = (p: MemberPlan) => (p.kind === 'create' ? titles[p.branch] ?? p.title : '');
  const merged = plans.some((p) => p.kind === 'merged');
  const emptyTitle = plans.some((p) => p.kind === 'create' && !titleOf(p).trim());
  const label = submitLabel(plans, kind);
  const submit = async () => {
    const ctx = writeCtx(req.tabId);
    const target = forgeTarget(req.tabId);
    if (!ctx || !target || !view || !label || merged || emptyTitle) return;
    if (busy.current) return;
    busy.current = true;
    close();
    useToast.getState().show(`Creating the stack's ${noun}s…`, { sticky: true });
    const report = await runCreateStack(ctx, target, view, plans, Object.fromEntries(plans.map((p) => [p.branch, titleOf(p)])), draft);
    const s = createSummary(report, kind);
    useToast.getState().show(s.message, { error: s.error, tone: s.warning && !s.error ? 'warning' : undefined, detail: s.detail });
  };
  // Enter in a title never creates (a forge write; the form's implicit submit does nothing): only
  // the button or Ctrl+Enter does. The modal's key claim means the router sees the key first.
  useKeys('menu', (e) => {
    if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey) || !isTopModal(ref)) return;
    e.preventDefault();
    void submit();
    return 'handled';
  });
  return (
    <div className="modal-backdrop" onPointerDown={close}>
      <div ref={ref} className="modal stack-create" role="dialog" aria-modal="true" aria-labelledby="stack-create-title" onPointerDown={(e) => e.stopPropagation()}>
        <h2 id="stack-create-title">Create stack {noun}s</h2>
        {view && (
          <p className="stack-create-intro">
            {view.mode === 'native' ? `Each ${noun} targets the branch below it. GitLab shows them as a stack.` : `Each ${noun} targets the branch below it. GitBolt keeps a Stack table in every description up to date.`}
          </p>
        )}
        {!view && !error && <p className="stack-create-intro">Loading the stack's {noun}s…</p>}
        <p role="alert" className="modal-error stack-create-error">{error}</p>
        <form onSubmit={(e) => e.preventDefault()}>
          <ol className="stack-create-list" aria-label="Stack">
            {plans.map((p, i) => (
              <li key={p.branch}>
                <span className="stack-create-pos">{i + 1}</span>
                <span className="stack-create-branches">{p.branch} <ArrowGlyph /> {p.target}</span>
                {p.kind === 'create' && <input aria-label={`Title for ${p.branch}`} value={titleOf(p)} onChange={(e) => setTitles({ ...titles, [p.branch]: e.target.value })} spellCheck={false} />}
                {p.kind === 'ok' && <span className="stack-create-note">{mrRef(kind, p.mr.number)} is open</span>}
                {p.kind === 'retarget' && <span className="stack-create-note">{mrRef(kind, p.mr.number)}: retarget from {p.mr.targetBranch}</span>}
                {p.kind === 'merged' && <span className="stack-create-note modal-error">{mrRef(kind, p.mr.number)} is merged: rebase the stack first</span>}
              </li>
            ))}
          </ol>
          {plans.some((p) => p.kind === 'create') && (
            <label className="modal-check">
              <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} /> Create as drafts
            </label>
          )}
          <div className="modal-actions">
            <button type="button" onClick={close}>Cancel</button>
            <button type="button" className="primary" onClick={() => void submit()} disabled={!label || merged || emptyTitle}>{label ?? `Create stack ${noun}s`}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

export const offCreateStackDialog = registerAppSlot('overlay', 'createStack', CreateStackDialog);

registerKeyHints([
  { id: 'key.stackCreate', section: 'Merge request', label: 'Create the stack of merge/pull requests', keys: ['Mod+Enter'], context: '(in the Create stack dialog)', source: 'forge/stack/CreateStackDialog.tsx' },
]);
