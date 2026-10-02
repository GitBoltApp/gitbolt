import { Loader2 } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { inProgressOf } from '../conflicts/inProgress';
import { api } from '../api/client';
import { selectCommit } from '../app/graphNav';
import { useRepoContext } from '../app/repoContext';
import { useRuntime } from '../app/runtime';
import { useRepoView } from '../repo/store';
import { useWipCtx } from '../stage/actions';
import { stagingKey, useCommitting, useStaging } from '../stage/store';
import { HoverTooltip } from '../ui/HoverTooltip';
import { runWrite } from '../write/client';
import { CommitFields } from './CommitFields';
import { clearWipDraft, draftKey, splitMessage, useWipDraft, type WipDraft } from './draft';
import { useCommitBox } from './store';

const files = (n: number) => `${n} ${n === 1 ? 'file' : 'files'}`;

/** The button's label, and why it's disabled (spec #2 §8.1). */
export function commitButton(s: { staged: number; unstaged: number; conflicted: number; amend: boolean; inMerge: boolean; summary: string }) {
  const stageAll = !s.amend && !s.inMerge && s.staged === 0 && s.unstaged > 0;
  const label = s.amend ? 'Amend previous commit' : s.inMerge ? 'Commit merge' : stageAll ? 'Stage all & commit' : `Commit changes to ${files(s.staged)}`;
  const reason =
    s.conflicted > 0 ? `Resolve ${s.conflicted} conflicted ${s.conflicted === 1 ? 'file' : 'files'} first`
      : !s.amend && !s.inMerge && s.staged === 0 && s.unstaged === 0 ? 'Nothing to commit'
        : !s.summary.trim() ? 'Write a commit summary'
          : null;
  return { label, disabled: reason !== null, reason, stageAll };
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

// --- 2D T16: the conflict banner's [Commit] focuses the box ---
const mounted = new Map<string, () => void>();
let pendingFocus: string | null = null;
/** Puts the keyboard in the tab's commit summary; if the WIP panel isn't showing yet, as soon as it does. */
export function focusCommitBox(tabId: string): void {
  const focus = mounted.get(tabId);
  if (focus) focus();
  else pendingFocus = tabId;
}
// --- end 2D T16 ---

/** Spec #2 §8.1: at the bottom of the WIP panel. `inMerge`: the worktree is mid-merge (2D, "Commit merge"). */
export function CommitBox({ inMerge: forced = false }: { inMerge?: boolean }) {
  const ctx = useWipCtx();
  const { tabId } = useRepoContext();
  const repoPath = useRepoView((s) => s.repoPath);
  const services = useRepoView((s) => s.services);
  const worktree = ctx?.worktree ?? '';
  const inMerge = useRepoView((s) => forced || (!!worktree && inProgressOf(s.graph, worktree)?.kind === 'merge'));
  const head = useWorktreeHead(ctx?.worktree ?? null);
  const [draft, setDraft] = useWipDraft(repoPath, worktree);
  const key = draftKey(repoPath, worktree);
  const amend = useCommitBox((s) => s.amend[key]);
  const committing = useCommitting(ctx?.repoId ?? -1, worktree);
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
  // §8.2: a HEAD move (checkout, reset, undo) ends the amend; the draft shows again.
  useEffect(() => {
    if (amend && head !== amend.head) useCommitBox.getState().cancelAmend(key);
  }, [amend, head, key]);
  if (!ctx) return null;
  const value = amend ? amend.text : draft;
  const onChange = (d: WipDraft) => (amend ? useCommitBox.getState().setAmendText(key, d) : setDraft(d));
  const view = commitButton({ staged, unstaged, conflicted, amend: !!amend, inMerge, summary: value.summary });

  const toggleAmend = async (on: boolean) => {
    if (!on) return useCommitBox.getState().cancelAmend(key);
    if (amend || !head) return;
    const m = await services.messages.get(head);
    // §8.2: CRLF and a description's leading blank lines are normalised whenever text is loaded.
    useCommitBox.getState().startAmend(key, splitMessage(`${m.summary}\n${m.body}`), head);
  };

  const submit = async () => {
    const { setCommitting, committing: gate } = useStaging.getState();
    if (view.disabled || gate[stagingKey(ctx.repoId, worktree)]) return;
    setCommitting(ctx.repoId, worktree, true);
    try {
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
      <CommitFields value={value} onChange={onChange} onSubmit={() => void submit()} disabled={committing} />
      <div className="commit-box-row">
        <HoverTooltip content={inMerge ? 'Finish the merge first' : 'Amend the previous commit'}>
          <label className="commit-amend">
            <input type="checkbox" checked={!!amend} disabled={!head || committing || inMerge} onChange={(e) => void toggleAmend(e.target.checked)} />
            Amend
          </label>
        </HoverTooltip>
        <HoverTooltip content={view.reason ?? `${view.label} (Ctrl+Enter)`}>
          <button type="button" className="commit-button primary" aria-disabled={view.disabled || committing} aria-busy={committing} onClick={() => void submit()}>
            {committing && <Loader2 className="spin" size={13} aria-hidden />}
            {view.label}
          </button>
        </HoverTooltip>
      </div>
    </div>
  );
}
