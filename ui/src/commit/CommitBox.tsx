import { Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { selectCommit } from '../app/graphNav';
import { useLend } from '../app/lent';
import { useRepoContext } from '../app/repoContext';
import { useOps } from '../app/ops';
import { useRuntime } from '../app/runtime';
import { resolveFirst, useIntegrating, type OperationView } from '../conflicts/inProgress';
import { markAborting, restoreDraftAfterAbort } from '../conflicts/mergeDraft';
import { useOperation } from '../conflicts/useOperation';
import { useRepoView } from '../repo/store';
import { useWipCtx } from '../stage/actions';
import { stagingKey, useCommitting, useStaging, useStagingBusy } from '../stage/store';
import { HoverTooltip } from '../ui/HoverTooltip';
import { useToast } from '../ui/toastStore';
import { currentOrigin, type Origin } from '../ui/arm/origin';
import { confirmAction } from '../ui/ConfirmDialog';
import { useDisarmOnChange } from '../ui/arm/useDisarmOnChange';
import { runWrite, type WriteCtx } from '../write/client';
import { CommitFields } from './CommitFields';
import { CommitIdentityLine } from './CommitIdentity';
import { clearWipDraft, draftKey, draftMessage, EMPTY_DRAFT, splitMessage, useWipDraft, type WipDraft } from './draft';
import { useCommitBox } from './store';
import { toastRebaseOutcome } from '../irebase/outcome';

const files = (n: number) => `${n} ${n === 1 ? 'file' : 'files'}`;

/** The button's label when the summary is empty: it says what's missing. */
export const TYPE_A_MESSAGE = 'Type a message to commit';

/** The commit button's reason while a stage, unstage or discard of the worktree is in flight. */
export const STAGING_BUSY = 'Staging…';

/** The button's label, and why it's disabled (spec #2 §8.1). `staging`: a staging write is in
 * flight, so the counts (and Stage all & commit) are about to change: it waits, label unchanged. */
export function commitButton(s: { staged: number; unstaged: number; conflicted: number; amend: boolean; inMerge: boolean; summary: string; staging?: boolean }) {
  const stageAll = !s.amend && !s.inMerge && s.staged === 0 && s.unstaged > 0;
  const action = s.amend ? 'Amend previous commit' : s.inMerge ? 'Commit and merge' : stageAll ? 'Stage all & commit' : `Commit changes to ${files(s.staged)}`;
  const reason =
    s.staging ? STAGING_BUSY
    : s.conflicted > 0 ? resolveFirst(s.conflicted)
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

const NO_FILES: readonly { path: string; status: string }[] = [];
/** The panel's unstaged files (untracked ones are `A` there). */
function useUnstagedFiles() {
  return useRepoView((s) => {
    const sec = s.panel?.selection.kind === 'wip' ? s.panel.sections[0] : undefined;
    return sec?.list.status === 'ready' ? sec.list.data.files : NO_FILES;
  });
}

/** UX L: Continue's reason while a file the stopped commit adds is left untracked (the core's too). */
export const notStaged = (file: string) => `${file} from this commit isn't staged. Stage it, or discard it, then Continue.`;

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
      {op.caution && <span className="commit-op-hint">{op.caution}</span>}
    </section>
  );
}

/** 3C T13: what an Abort at an Edit stop keeps: only commits made there (on a branch), or the
 * stop's work in general (changes in a stash, and maybe commits); `null`, nothing. */
export type KeptWork = 'commits' | 'work' | null;

/** Abort's arm-in-place confirm: what it throws away, or (3C T13) keeps. */
function abortConfirm(op: OperationView, name: string, resolved: number, kept: KeptWork) {
  const back = `The branch goes back to how it was before the ${name}.`;
  // --- 3C T13: an Edit stop's work is kept; a rebase's conflict stop loses its resolution ---
  // UX N: the core keeps only what can't be had again, so the copy says "new".
  if (op.kind === 'rebase' && op.editStop && kept === 'commits') {
    return { arm: 'Click again to abort: new commits from the stop are kept on a branch', body: `${back} New commits from the stop are kept on a branch.` };
  }
  if (op.kind === 'rebase' && op.editStop && kept === 'work') {
    return { arm: 'Click again to abort: new work from the stop is kept', body: `${back} New work from the stop is kept.` };
  }
  if (op.kind === 'rebase' && !op.editStop && resolved > 0 && op.keepsWork) {
    // Fix round 1: a side taken whole (ours, theirs) is in the commits: only hand-made changes are kept.
    return { arm: 'Click again to abort: changes you made by hand are kept', body: `${back} Changes you made by hand are kept in a stash.` };
  }
  if (op.kind === 'rebase' && !op.editStop && resolved > 0) {
    return { arm: 'Click again to abort: discards the conflict resolution so far', body: `${back} The conflict resolution so far is discarded.` };
  }
  // --- end 3C T13 ---
  return { arm: resolved > 0 ? `Click again to abort: undoes ${files(resolved)} resolved` : `Click again to abort the ${name}`, body: back };
}

/** UX L: Continue's refusal at an Edit stop while changes are left unstaged (the core's too). */
export const COMMIT_OR_DISCARD = 'Commit or discard your changes first';

/** Skip and Abort, below the primary button. Abort arms in place over Skip (spec §ui confirms,
 * board D); `resolved`, the files resolved so far, which it throws away. 3C T13: `cont`, Continue
 * rebase here (an Edit stop where the box commits), and `kept`: the stop's work Abort keeps. */
function OperationActions({ op, ctx, repoPath, disabled, resolved, cont, kept = null }: { op: OperationView; ctx: WriteCtx; repoPath: string; disabled: boolean; resolved: number; cont?: { reason: string | null; tip: string; run(): void }; kept?: KeptWork }) {
  // An armed Abort counts the resolved files: a different count disarms it.
  const actions = useRef<HTMLDivElement>(null);
  useDisarmOnChange(actions, `${resolved}:${kept}`);
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
      } else if (op.kind === 'rebase') toastRebaseOutcome(await runWrite(ctx, () => api.rebaseControl(ctx.repoId, ctx.worktree, action), { origin }));
      else await runWrite(ctx, () => api.pickControl(ctx.repoId, ctx.worktree, action), { origin });
    } finally {
      setCommitting(ctx.repoId, ctx.worktree, false);
    }
  };
  const abort = async () => {
    if (disabled) return;
    const origin = currentOrigin();
    const { arm, body } = abortConfirm(op, name, resolved, kept);
    const ok = await confirmAction({ title: `Abort the ${name}?`, body, confirmLabel: `Abort ${name}`, arm, danger: true }, origin);
    if (ok) await control('abort', origin)();
  };
  return (
    <div ref={actions} className="commit-op-actions" data-arm-cover="">
      {/* 3C T13, UX L: an Edit stop where the box commits: Continue under it. */}
      {cont && (
        <HoverTooltip content={cont.reason ?? cont.tip}>
          <button type="button" className="commit-positive" aria-disabled={disabled || !!cont.reason || undefined} onClick={() => { if (!disabled && !cont.reason) cont.run(); }}>Continue rebase</button>
        </HoverTooltip>
      )}
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
  // --- 3C T13, UX L: an Edit stop (spec #3 §3.5) ---
  // GitBolt's own stop is "about to commit" (UX L, `editBase`): the commit's changes staged, its
  // message the box's. The box commits normally (pieces, the rebase stays stopped), and Continue
  // under it commits what's staged with the box's message, then goes on.
  // git's own stop (no `editBase`) HEAD has left: the box commits normally, and Continue waits
  // under it until nothing is left to commit.
  // A rebase started in a terminal (fix 1 A1): the core refuses Commit there, so the box stays
  // Continue's.
  const editStaged = !!op?.editStop && !!op.editBase && !op.editElsewhere;
  const headLeft = !!op?.editStop && head !== op.editStop;
  const editMoved = headLeft && !op?.editElsewhere && !editStaged;
  const boxOp = editMoved || editStaged ? null : op;
  // Commits made at the stop: HEAD off the commit's parent (UX L), or off git's commit.
  const madeCommits = editStaged ? head !== op?.editBase : headLeft;
  // --- end 3C T13 ---
  const [draft, setDraft] = useWipDraft(repoPath, worktree);
  const key = draftKey(repoPath, worktree);
  const amend = useCommitBox((s) => s.amend[key]);
  const opText = useCommitBox((s) => s.op[key]);
  const committing = useCommitting(repoId, worktree);
  const staging = useStagingBusy(repoId, worktree);
  const [staged, unstaged, conflicted] = useCounts();
  const unstagedFiles = useUnstagedFiles();
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
  // ends it too: the box is the operation's (not an Edit stop HEAD has left: the box is the normal one).
  const opOwnsBox = !!operation && !editMoved && !(editStaged && madeCommits);
  useEffect(() => {
    if (amend && (head !== amend.head || opOwnsBox)) useCommitBox.getState().cancelAmend(key);
  }, [amend, head, key, opOwnsBox]);
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
  // Ctrl+Enter from outside the message (`commit/keyActions.ts`), set below once the view is known.
  const keySubmit = useRef<() => void>(() => {});
  useLend('commit.commit', tabId, ctx ? () => keySubmit.current() : null);
  if (!ctx) return null;
  // UX L: at the "about to commit" stop the box holds the stop's message, not the WIP draft.
  const opBox = !!boxOp || editStaged;
  const value = amend ? amend.text : opBox ? (opText?.text ?? EMPTY_DRAFT) : draft;
  const onChange = (d: WipDraft) => (amend ? useCommitBox.getState().setAmendText(key, d) : opBox ? useCommitBox.getState().setOpText(key, d) : setDraft(d));
  const view = boxOp ? continueButton(boxOp, value) : commitButton({ staged, unstaged, conflicted, amend: !!amend, inMerge, summary: value.summary, staging });
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
      if (boxOp) {
        // Continue commits the stopped pick with the box's message, if the user edited it;
        // otherwise git's own, untouched.
        const message = continueMessage(opText);
        if (boxOp.kind === 'rebase') toastRebaseOutcome(await runWrite(ctx, () => api.rebaseControl(ctx.repoId, worktree, 'continue', message)));
        else await runWrite(ctx, () => api.pickControl(ctx.repoId, worktree, 'continue', message));
        return;
      }
      // §8.2: a failed commit (hook, signing, cancel) keeps the draft. The follow-up is `onSuccess`,
      // so a Retry from the error toast does it too.
      await runWrite(ctx, () => api.commit(ctx.repoId, worktree, { summary: value.summary, description: value.description, amend: !!amend, stageAll: view.stageAll, expect: { head, refs: {} } }), {
        onSuccess: async (out) => {
          if (amend) useCommitBox.getState().cancelAmend(key);
          // UX L: a piece committed at the stop: the box empties for the next one.
          else if (editStaged) useCommitBox.getState().setOpText(key, EMPTY_DRAFT);
          else clearWipDraft(repoPath, worktree);
          await useRuntime.getState().refresh(tabId, { graphOnly: true });
          // 3C T14: at an Edit stop the WIP stays selected: the next piece and Continue are here
          // (spec #3 §3.5, over spec #2 §8.2's rule).
          if (!editMoved && !editStaged) selectCommit(tabId, out.oid);
        },
      });
    } finally {
      setCommitting(ctx.repoId, worktree, false);
    }
  };

  // What the button does; with nothing it can do yet, the keyboard goes to the message, and why.
  keySubmit.current = () => {
    if (committing || integrating) return;
    if (!view.disabled) return void submit();
    boxRef.current?.querySelector<HTMLInputElement>('.commit-summary')?.focus();
    if (view.reason) useToast.getState().show(view.reason);
  };

  // --- 3C T13: Continue under the box, behind the box's gate (review 4) ---
  const gated = (write: () => Promise<unknown>) => async () => {
    const { setCommitting, committing: gate } = useStaging.getState();
    if (integrating || gate[stagingKey(ctx.repoId, worktree)]) return;
    setCommitting(ctx.repoId, worktree, true);
    try {
      await write();
    } finally {
      setCommitting(ctx.repoId, worktree, false);
    }
  };
  const goOn = (message?: string) => () =>
    void gated(async () => toastRebaseOutcome(await runWrite(ctx, () => (message === undefined ? api.rebaseControl(ctx.repoId, worktree, 'continue') : api.rebaseControl(ctx.repoId, worktree, 'continue', message)))))();
  // UX L (L.2): what's staged is committed with the box's message (the original's author kept),
  // then the rebase goes on; nothing staged, it just goes on. Changes left unstaged wait.
  // The stop's message, never an amend's: Amend (of a piece) is ticked off first.
  const stopText = opText?.text ?? EMPTY_DRAFT;
  // Fix round 1, as the core: tracked changes left unstaged, or a file the commit adds left
  // untracked, hold Continue up; any other untracked file (`.env`, build output) doesn't.
  const trackedLeft = unstagedFiles.filter((f) => f.status !== 'A' && f.status !== 'U').length;
  const leftover = editStaged ? unstagedFiles.find((f) => f.status === 'A' && op?.editAdded?.includes(f.path))?.path : undefined;
  const cont = editStaged
    ? {
        reason: staging ? STAGING_BUSY
          : amend ? 'Untick Amend first'
            : trackedLeft + conflicted > 0 ? COMMIT_OR_DISCARD
              : leftover ? notStaged(leftover)
                : staged > 0 && !stopText.summary.trim() ? 'Write a commit summary'
                  : null,
        tip: staged > 0 ? `Commit ${files(staged)} with this message, then go on with the rebase` : 'Go on with the rebase',
        // Unedited, no message: the core commits with the stop's own, as it is (a commit nothing
        // changed in stays git's, its oid too).
        run: goOn(staged > 0 ? continueMessage(opText) : undefined),
      }
    : editMoved
      ? { reason: staged + unstaged + conflicted > 0 ? COMMIT_OR_DISCARD : null, tip: 'Go on with the rebase', run: goOn() }
      : undefined;
  // What Abort keeps (M5): commits made at the stop, else changes there; both, or not knowing
  // which, is "your work". UX L: what's staged at the "about to commit" stop is the commit's own
  // unless the index differs from it (`editChanged`); untracked files aren't kept.
  // git's own stop HEAD has left can't tell commits from a reset: "your work".
  const left = editStaged ? trackedLeft + conflicted > 0 || !!op?.editChanged : unstaged + conflicted > 0;
  const kept: KeptWork = !op?.editStop ? null
    : editStaged ? (madeCommits && !left ? 'commits' : madeCommits || left ? 'work' : null)
      : headLeft || staged > 0 || left ? 'work' : null;
  // --- end 3C T13 ---

  return (
    <div ref={boxRef} className="commit-box" data-testid="commit-box">
      {operation && <OperationStatus op={operation} />}
      <CommitFields value={value} onChange={onChange} onSubmit={() => void submit()} disabled={committing || operation?.primary === null} />
      <div className="commit-box-row">
        {/* UX L: at the "about to commit" stop, once a piece is committed (it can be amended). */}
        {(!operation || editMoved || (editStaged && madeCommits)) && (
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
      {operation && <OperationActions op={operation} ctx={ctx} repoPath={repoPath} disabled={committing || integrating} resolved={op?.editStop ? 0 : staged} cont={cont} kept={kept} />}
      {committing && <StillWorking repoId={ctx.repoId} />}
    </div>
  );
}

/** UX F: how long a write from the box (Commit, Continue, Skip, Abort) runs on its spinner
 * alone before the box says so, with Cancel. */
export const STILL_WORKING_MS = 30_000;

/** UX F: shown while the box's write runs (mounted with it); after `STILL_WORKING_MS`, "Still
 * working…" and Cancel, the running write's own (as the status bar's): a signer waiting on a
 * passphrase nobody sees is never an endless spinner. A cancelled Continue leaves the rebase paused. */
function StillWorking({ repoId }: { repoId: number }) {
  const [late, setLate] = useState(false);
  // Fix round 1: the box's own write, by id. Mounted as the box's gate closes, before its request
  // goes out: the ops running then are someone else's; the box's is the first write of this repo
  // to start after (the queue runs a repo's writes in order). Cancel only ever reaches that one.
  const [before] = useState(() => new Set(Object.keys(useOps.getState().ops).map(Number)));
  const [mine, setMine] = useState<number | null>(null);
  useEffect(() => {
    if (mine !== null) return;
    const find = (ops: ReturnType<typeof useOps.getState>['ops']) => {
      const ids = Object.values(ops).filter((o) => o.interactive && o.repo === repoId && o.kind !== 'fetch' && o.kind !== 'clone' && !before.has(o.op)).map((o) => o.op);
      if (ids.length) setMine(Math.min(...ids));
    };
    find(useOps.getState().ops);
    return useOps.subscribe((s) => find(s.ops));
  }, [before, mine, repoId]);
  const running = useOps((s) => mine !== null && s.ops[mine] !== undefined);
  useEffect(() => {
    const t = setTimeout(() => setLate(true), STILL_WORKING_MS);
    return () => clearTimeout(t);
  }, []);
  if (!late) return null;
  const op = running && mine !== null ? { op: mine } : null;
  return (
    <div className="commit-still" role="status" data-testid="commit-still">
      <Loader2 className="spin" size={12} aria-hidden />
      <span>Still working…</span>
      {op && (
        <HoverTooltip content="Stop it: nothing is lost, and a rebase stays paused where it was">
          <button type="button" className="commit-still-cancel" onClick={() => void api.cancelOp(op.op).catch((e: unknown) => console.warn('[gitbolt] cancel', e))}>Cancel</button>
        </HoverTooltip>
      )}
    </div>
  );
}
