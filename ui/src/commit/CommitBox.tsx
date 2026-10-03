import { Loader2 } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { api } from '../api/client';
import { selectCommit } from '../app/graphNav';
import { useRepoContext } from '../app/repoContext';
import { useRuntime } from '../app/runtime';
import { resolveFirst, useIntegrating, type OperationView } from '../conflicts/inProgress';
import { markAborting, restoreDraftAfterAbort } from '../conflicts/mergeDraft';
import { useOperation } from '../conflicts/useOperation';
import { useRepoView } from '../repo/store';
import { useWipCtx } from '../stage/actions';
import { stagingKey, useCommitting, useStaging } from '../stage/store';
import { HoverTooltip } from '../ui/HoverTooltip';
import { currentOrigin, type Origin } from '../ui/arm/origin';
import { confirmAction } from '../ui/ConfirmDialog';
import { useDisarmOnChange } from '../ui/arm/useDisarmOnChange';
import { runWrite, type WriteCtx } from '../write/client';
import { CommitFields } from './CommitFields';
import { CommitIdentityLine } from './CommitIdentity';
import { clearWipDraft, draftKey, draftMessage, EMPTY_DRAFT, splitMessage, useWipDraft, type WipDraft } from './draft';
import { useCommitBox } from './store';

const files = (n: number) => `${n} ${n === 1 ? 'file' : 'files'}`;

/** The button's label when the summary is empty: it says what's missing. */
export const TYPE_A_MESSAGE = 'Type a message to commit';

/** The button's label, and why it's disabled (spec #2 §8.1). */
export function commitButton(s: { staged: number; unstaged: number; conflicted: number; amend: boolean; inMerge: boolean; summary: string }) {
  const stageAll = !s.amend && !s.inMerge && s.staged === 0 && s.unstaged > 0;
  const action = s.amend ? 'Amend previous commit' : s.inMerge ? 'Commit and merge' : stageAll ? 'Stage all & commit' : `Commit changes to ${files(s.staged)}`;
  const reason =
    s.conflicted > 0 ? resolveFirst(s.conflicted)
      : !s.amend && !s.inMerge && s.staged === 0 && s.unstaged === 0 ? 'Nothing to commit'
        : !s.summary.trim() ? 'Write a commit summary'
          : null;
  return { label: s.summary.trim() ? action : TYPE_A_MESSAGE, disabled: reason !== null, reason, stageAll };
}

/** A rebase, cherry-pick or revert's primary button (ux round 1). An unedited (or emptied) box
 * sends no message: git commits with its own. A description with no summary would be lost, so
 * it waits for one (review 6). */
export function continueButton(op: OperationView, text: WipDraft = EMPTY_DRAFT) {
  const reason = op.primary === null ? op.hint
    : op.conflicted > 0 ? resolveFirst(op.conflicted)
      : !text.summary.trim() && text.description.trim() ? 'Write a commit summary'
        : null;
  return { label: op.primary ?? 'Commit', disabled: reason !== null, reason, stageAll: false };
}

/** What Continue sends: the box's message, only when the user edited it (review 1). */
export function continueMessage(op: { text: WipDraft; edited: boolean } | undefined): string | undefined {
  return op?.edited && op.text.summary.trim() ? draftMessage(op.text) : undefined;
}

/** The panel's counts: staged and unstaged files, and the conflicted ones (status `U`, §7.1). */
function useCounts() {
  return useRepoView((s) => {
    const [unstaged, staged] = s.panel?.selection.kind === 'wip' ? s.panel.sections : [];
    const list = (sec: typeof unstaged) => (sec?.list.status === 'ready' ? sec.list.data.files : []);
    const u = list(unstaged);
    const conflicted = u.filter((f) => f.status === 'U').length;
    return `${list(staged).filter((f) => f.status !== 'U').length}:${u.length - conflicted}:${conflicted}`;
  }).split(':').map(Number) as [number, number, number];
}

/** The WIP row's HEAD commit: its parent (`null` when the branch is unborn). */
function useWorktreeHead(worktree: string | null): string | null {
  return useRepoView((s) => s.graph.rows.find((r) => r.wip?.worktreePath === worktree)?.parents[0] ?? null);
}

// --- 2D T16: something outside the box puts the keyboard in it ---
const mounted = new Map<string, () => void>();
let pendingFocus: string | null = null;
/** Puts the keyboard in the tab's commit summary; if the WIP panel isn't showing yet, as soon as it does. */
export function focusCommitBox(tabId: string): void {
  const focus = mounted.get(tabId);
  if (focus) focus();
  else pendingFocus = tabId;
}
// --- end 2D T16 ---

/** The operation's status, at the top of the commit box (§13.2): it replaces the window-wide bar. */
function OperationStatus({ op }: { op: OperationView }) {
  return (
    <section className="commit-op" aria-label={op.region}>
      <span className="commit-op-title">{op.title}</span>
      {op.detail && <span className="commit-op-detail">{op.detail}</span>}
      <span className={`commit-op-hint${op.conflicted ? ' conflicted' : ''}`}>{op.hint}</span>
    </section>
  );
}

/** Skip and Abort, below the primary button. Abort arms in place over Skip (spec §ui confirms,
 * board D); `resolved`, the files resolved so far, which it throws away. */
function OperationActions({ op, ctx, repoPath, disabled, resolved }: { op: OperationView; ctx: WriteCtx; repoPath: string; disabled: boolean; resolved: number }) {
  // An armed Abort counts the resolved files: a different count disarms it.
  const actions = useRef<HTMLDivElement>(null);
  useDisarmOnChange(actions, resolved);
  if (op.primary === null) return null;
  const name = op.kind === 'cherryPick' ? 'cherry-pick' : op.kind;
  // Review 4: the box's gate (the same as Commit's) is held while one runs, so a double click
  // can't skip two commits.
  // `origin`: where the action started, captured before Abort's confirm (spec §ui confirms).
  const control = (action: 'skip' | 'abort', origin: Origin | null = currentOrigin()) => async () => {
    const { setCommitting, committing: gate } = useStaging.getState();
    if (disabled || gate[stagingKey(ctx.repoId, ctx.worktree)]) return;
    setCommitting(ctx.repoId, ctx.worktree, true);
    try {
      if (op.kind === 'merge') {
        markAborting(repoPath, ctx.worktree, true);
        await runWrite(ctx, () => api.mergeAbort(ctx.repoId, ctx.worktree), { onSuccess: () => restoreDraftAfterAbort(repoPath, ctx.worktree, origin), origin }).finally(() => markAborting(repoPath, ctx.worktree, false));
      } else if (op.kind === 'rebase') await runWrite(ctx, () => api.rebaseControl(ctx.repoId, ctx.worktree, action), { origin });
      else await runWrite(ctx, () => api.pickControl(ctx.repoId, ctx.worktree, action), { origin });
    } finally {
      setCommitting(ctx.repoId, ctx.worktree, false);
    }
  };
  const abort = async () => {
    if (disabled) return;
    const origin = currentOrigin();
    const arm = resolved > 0 ? `Click again to abort: undoes ${files(resolved)} resolved` : `Click again to abort the ${name}`;
    const ok = await confirmAction({ title: `Abort the ${name}?`, body: `The branch goes back to how it was before the ${name}.`, confirmLabel: `Abort ${name}`, arm, danger: true }, origin);
    if (ok) await control('abort', origin)();
  };
  return (
    <div ref={actions} className="commit-op-actions" data-arm-cover="">
      {op.skip && (
        <HoverTooltip content={op.kind === 'rebase' ? 'Drop the stopped commit and go on' : `Drop this commit's ${name} and go on`}>
          <button type="button" className="commit-neutral" aria-disabled={disabled || undefined} onClick={control('skip')}>Skip</button>
        </HoverTooltip>
      )}
      <HoverTooltip content={op.kind === 'merge' ? 'Put the branch back as it was before the merge' : `Put the branch back as it was before the ${name}`}>
        <button type="button" className="commit-danger" aria-disabled={disabled || undefined} onClick={() => void abort()}>Abort {name}</button>
      </HoverTooltip>
    </div>
  );
}

/** Spec #2 §8.1: at the bottom of the WIP panel. `inMerge`: the worktree is mid-merge (2D, "Commit and merge").
 * A rebase, cherry-pick or revert in progress takes the box over (§13.2, ux round 1): its status on
 * top, the stopped commit's message in the fields, and Continue, Skip and Abort. */
export function CommitBox({ inMerge: forced = false }: { inMerge?: boolean }) {
  const ctx = useWipCtx();
  const { tabId } = useRepoContext();
  const repoPath = useRepoView((s) => s.repoPath);
  const services = useRepoView((s) => s.services);
  const worktree = ctx?.worktree ?? '';
  const repoId = ctx?.repoId ?? -1;
  const operation = useOperation(repoId, worktree);
  const inMerge = forced || operation?.kind === 'merge';
  // The operations whose message is their own, not the WIP draft's (a merge's is the draft, §8.2).
  const op = operation && operation.kind !== 'merge' ? operation : null;
  const integrating = useIntegrating(repoId);
  const head = useWorktreeHead(ctx?.worktree ?? null);
  const [draft, setDraft] = useWipDraft(repoPath, worktree);
  const key = draftKey(repoPath, worktree);
  const amend = useCommitBox((s) => s.amend[key]);
  const opText = useCommitBox((s) => s.op[key]);
  const committing = useCommitting(repoId, worktree);
  const [staged, unstaged, conflicted] = useCounts();
  // Disabling the fields for the commit drops their focus: put it back on the summary afterwards.
  const boxRef = useRef<HTMLDivElement>(null);
  const wasCommitting = useRef(false);
  useEffect(() => {
    if (wasCommitting.current && !committing) boxRef.current?.querySelector<HTMLInputElement>('.commit-summary')?.focus();
    wasCommitting.current = committing;
  }, [committing]);
  // --- 2D T16 ---
  useEffect(() => {
    const focus = () => boxRef.current?.querySelector<HTMLInputElement>('.commit-summary')?.focus();
    mounted.set(tabId, focus);
    if (pendingFocus === tabId) {
      pendingFocus = null;
      focus();
    }
    return () => void mounted.delete(tabId);
  }, [tabId]);
  // --- end 2D T16 ---
  // §8.2: a HEAD move (checkout, reset, undo) ends the amend; the draft shows again. An operation
  // ends it too: the box is the operation's.
  useEffect(() => {
    if (amend && (head !== amend.head || operation)) useCommitBox.getState().cancelAmend(key);
  }, [amend, head, key, operation]);
  // Ux round 1: each stop prefills the box with git's message for it, once; edits stay until
  // Continue. The operation over, the draft shows again.
  const stop = op?.primary ? op.stop : null;
  useEffect(() => {
    if (!op || !stop) {
      if (!operation && useCommitBox.getState().op[key]) useCommitBox.getState().clearOp(key);
      return;
    }
    if (useCommitBox.getState().op[key]?.stop === stop) return;
    let live = true;
    const fill = (m: string) => live && useCommitBox.getState().startOp(key, m.trim() ? splitMessage(m) : EMPTY_DRAFT, stop);
    if (op.message.trim() || !op.stoppedAt) fill(op.message);
    else services.messages.get(op.stoppedAt).then((m) => fill(`${m.summary}\n${m.body}`), () => fill(''));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, stop, !operation]);
  if (!ctx) return null;
  const value = amend ? amend.text : op ? (opText?.text ?? EMPTY_DRAFT) : draft;
  const onChange = (d: WipDraft) => (amend ? useCommitBox.getState().setAmendText(key, d) : op ? useCommitBox.getState().setOpText(key, d) : setDraft(d));
  const view = op ? continueButton(op, value) : commitButton({ staged, unstaged, conflicted, amend: !!amend, inMerge, summary: value.summary });
  const blocked = view.disabled || committing || integrating;

  const toggleAmend = async (on: boolean) => {
    if (!on) return useCommitBox.getState().cancelAmend(key);
    if (amend || !head) return;
    const m = await services.messages.get(head);
    // §8.2: CRLF and a description's leading blank lines are normalised whenever text is loaded.
    useCommitBox.getState().startAmend(key, splitMessage(`${m.summary}\n${m.body}`), head);
  };

  const submit = async () => {
    const { setCommitting, committing: gate } = useStaging.getState();
    if (view.disabled || integrating || gate[stagingKey(ctx.repoId, worktree)]) return;
    setCommitting(ctx.repoId, worktree, true);
    try {
      if (op) {
        // Continue commits the stopped pick with the box's message, if the user edited it;
        // otherwise git's own, untouched.
        const message = continueMessage(opText);
        if (op.kind === 'rebase') await runWrite(ctx, () => api.rebaseControl(ctx.repoId, worktree, 'continue', message));
        else await runWrite(ctx, () => api.pickControl(ctx.repoId, worktree, 'continue', message));
        return;
      }
      // §8.2: a failed commit (hook, signing, cancel) keeps the draft. The follow-up is `onSuccess`,
      // so a Retry from the error toast does it too.
      await runWrite(ctx, () => api.commit(ctx.repoId, worktree, { summary: value.summary, description: value.description, amend: !!amend, stageAll: view.stageAll, expect: { head, refs: {} } }), {
        onSuccess: async (out) => {
          if (amend) useCommitBox.getState().cancelAmend(key);
          else clearWipDraft(repoPath, worktree);
          await useRuntime.getState().refresh(tabId, { graphOnly: true });
          selectCommit(tabId, out.oid);
        },
      });
    } finally {
      setCommitting(ctx.repoId, worktree, false);
    }
  };

  return (
    <div ref={boxRef} className="commit-box" data-testid="commit-box">
      {operation && <OperationStatus op={operation} />}
      <CommitFields value={value} onChange={onChange} onSubmit={() => void submit()} disabled={committing || operation?.primary === null} />
      <div className="commit-box-row">
        {!operation && (
          <HoverTooltip content="Amend the previous commit">
            <label className="commit-amend">
              <input type="checkbox" checked={!!amend} disabled={!head || committing} onChange={(e) => void toggleAmend(e.target.checked)} />
              Amend
            </label>
          </HoverTooltip>
        )}
        <CommitIdentityLine repoId={ctx.repoId} worktree={worktree} />
      </div>
      <HoverTooltip content={view.reason ?? `${view.label} (Ctrl+Enter)`}>
        <button type="button" className="commit-button commit-positive" aria-disabled={blocked} aria-busy={committing} onClick={() => void submit()}>
          {committing && <Loader2 className="spin" size={13} aria-hidden />}
          {view.label}
        </button>
      </HoverTooltip>
      {operation && <OperationActions op={operation} ctx={ctx} repoPath={repoPath} disabled={committing || integrating} resolved={staged} />}
    </div>
  );
}
