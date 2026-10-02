import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { selectCommit } from '../app/graphNav';
import { useRuntime } from '../app/runtime';
import { CommitFields } from '../commit/CommitFields';
import { draftMessage, splitMessage, type WipDraft } from '../commit/draft';
import { runWrite, type WriteCtx } from '../write/client';

/**
 * Spec #2 §8.3: HEAD's message as the commit box's two fields, in place, with Save
 * (Ctrl+Enter) and Cancel (Esc). It runs `git commit --amend --only -F -`: the message only, so
 * staged changes stay out of it. It's journaled as an amend, and Undo brings the old commit back.
 */
export function HeadMessageEditor({ ctx, head, message, onDone }: { ctx: WriteCtx; head: string; message: { summary: string; body: string }; onDone: () => void }) {
  const [value, setValue] = useState<WipDraft>(() => splitMessage(`${message.summary}\n${message.body}`));
  const [upstream, setUpstream] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    api.headOnUpstream(ctx.repoId, ctx.worktree).then((u) => { if (live) setUpstream(u); }, () => {});
    return () => { live = false; };
  }, [ctx.repoId, ctx.worktree]);
  const save = async () => {
    if (busy || !value.summary.trim()) return;
    setBusy(true);
    try {
      const out = await runWrite(ctx, () => api.editHeadMessage(ctx.repoId, ctx.worktree, draftMessage(value), { head, refs: {} }));
      if (!out) return;
      onDone();
      await useRuntime.getState().refresh(ctx.tabId, { graphOnly: true });
      selectCommit(ctx.tabId, out.oid);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="head-message-editor" data-testid="head-message-editor">
      <CommitFields value={value} onChange={setValue} onSubmit={() => void save()} onEscape={onDone} disabled={busy} autoFocus />
      {upstream && <p role="note" className="head-message-note">This commit is on {upstream}; you'll need to force push.</p>}
      <div className="head-message-actions">
        <button type="button" onClick={onDone}>Cancel</button>
        <button type="button" className="primary" aria-disabled={busy || !value.summary.trim()} onClick={() => void save()}>Save</button>
      </div>
    </div>
  );
}
