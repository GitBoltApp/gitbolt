import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { selectCommit } from '../app/graphNav';
import { useRuntime } from '../app/runtime';
import { CommitFields } from '../commit/CommitFields';
import { draftMessage, splitMessage, type WipDraft } from '../commit/draft';
import { toastRebaseOutcome } from '../irebase/outcome';
import { runWrite, type WriteCtx } from '../write/client';

/**
 * Spec #2 §8.3: HEAD's message as the commit box's two fields, in place, with Save
 * (Ctrl+Enter) and Cancel (Esc). It runs `git commit --amend --only -F -`: the message only, so
 * staged changes stay out of it. It's journaled as an amend, and Undo brings the old commit back.
 * 3C T13: `older`, the commit edited isn't HEAD (spec #3 §3.6): Save rewords it in place, an
 * interactive rebase; `older.head` is HEAD's oid for the CAS, `older.pushed` the upstream that
 * already has it (the force-push note, when HEAD's own check doesn't say so).
 */
export function HeadMessageEditor({ ctx, head, older, message, onDone }: { ctx: WriteCtx; head: string; older?: { head: string; pushed?: string | null }; message: { summary: string; body: string }; onDone: () => void }) {
  const [value, setValue] = useState<WipDraft>(() => splitMessage(`${message.summary}\n${message.body}`));
  const [upstream, setUpstream] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    api.headOnUpstream(ctx.repoId, ctx.worktree).then((u) => { if (live) setUpstream(u); }, () => {});
    return () => { live = false; };
  }, [ctx.repoId, ctx.worktree]);
  // 3C T13 fix 1 (M3): the follow-ups run in runWrite's onSuccess, so an error toast's Retry that
  // succeeds runs them too; that Retry reads HEAD as it is then, not as this render saw it.
  const latest = useRef({ head, older });
  latest.current = { head, older };
  const save = async () => {
    if (busy || !value.summary.trim()) return;
    const message = draftMessage(value);
    setBusy(true);
    try {
      // --- 3C T13: an older commit, through runWrite's clean-restore question (as Start's) ---
      if (older) {
        await runWrite(ctx, (_confirmed, asked) => api.rewordCommit(ctx.repoId, ctx.worktree, head, message, { head: latest.current.older?.head ?? older.head, refs: {} }, asked.autostash), {
          onSuccess: async (out) => {
            onDone();
            toastRebaseOutcome(out);
            await useRuntime.getState().refresh(ctx.tabId, { graphOnly: true });
            // 3C final fix M4: the reworded commit, not its old (now unreachable) oid.
            if (out.status === 'done' && out.rewritten) selectCommit(ctx.tabId, out.rewritten);
          },
        });
        return;
      }
      // --- end 3C T13 ---
      await runWrite(ctx, () => api.editHeadMessage(ctx.repoId, ctx.worktree, message, { head: latest.current.head, refs: {} }), {
        onSuccess: async (out) => {
          onDone();
          await useRuntime.getState().refresh(ctx.tabId, { graphOnly: true });
          selectCommit(ctx.tabId, out.oid);
        },
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="head-message-editor" data-testid="head-message-editor">
      <CommitFields value={value} onChange={setValue} onSubmit={() => void save()} onEscape={onDone} disabled={busy} autoFocus />
      {(upstream ?? older?.pushed) && <p role="note" className="head-message-note">This commit is on {upstream ?? older?.pushed}; you'll need to force push.</p>}
      {older && <p role="note" aria-label="Reword note" className="head-message-note">Saving rebases the commits above it.</p>}
      <div className="head-message-actions">
        <button type="button" className="commit-neutral" onClick={onDone}>Cancel</button>
        <button type="button" className="commit-positive" aria-disabled={busy || !value.summary.trim()} onClick={() => void save()}>Save</button>
      </div>
    </div>
  );
}
