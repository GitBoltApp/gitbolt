import { Trash2 } from 'lucide-react';
import { useRef } from 'react';
import { StashIcon } from '../icons/stash';
import { useRepoContext } from '../app/repoContext';
import { useRepoView } from '../repo/store';
import { HoverTooltip } from '../ui/HoverTooltip';
import { useDisarmOnChange } from '../ui/arm/useDisarmOnChange';
import { stashPushFor } from '../stash/actions';
import { discardAll, useWipCtx } from '../stage/actions';
import { ActionIcon } from '../stage/RowActions';
import { COMMIT_QUEUED, useCommitting } from '../stage/store';

/** Spec §8.6, read-only in #1: `N file change(s) on [branch]`, no stage, unstage or discard
 * controls (#2). N counts each changed path once, staged or not. */
export function WipHeader() {
  // What the panel shows (feedback F12); its row is found by worktree, as the graph may have
  // been reloaded since.
  const selection = useRepoView((s) => s.panel?.selection);
  const wip = useRepoView((s) => {
    const sel = s.panel?.selection;
    if (sel?.kind !== 'wip') return null;
    const row = s.graph.rows[sel.index];
    return (row?.wip?.worktreePath === sel.worktree ? row : s.graph.rows.find((r) => r.wip?.worktreePath === sel.worktree))?.wip ?? null;
  });
  const count = useRepoView((s) => {
    const paths = new Set<string>();
    let ready = false;
    for (const sec of s.panel?.sections ?? []) {
      if (sec.list.status !== 'ready') continue;
      ready = true;
      for (const f of sec.list.data.files) paths.add(f.path);
    }
    return ready ? paths.size : wip ? wip.modified + wip.added + wip.deleted + wip.renamed + wip.conflicted : 0;
  });
  // A linked worktree's branch is on its label; the main worktree's is HEAD's.
  const branch = useRepoView((s) => {
    const sel = s.panel?.selection;
    if (sel?.kind !== 'wip') return null;
    // The worktree's own branch (the graph's worktree list is the tab's, whichever is active).
    const own = s.graph.worktrees.find((w) => w.path === sel.worktree)?.branch;
    if (own) return own.replace(/^refs\/heads\//, '');
    return s.graph.labels.find((l) => l.worktree === sel.worktree)?.name ?? (sel.name === null ? s.graph.head.branch?.replace(/^refs\/heads\//, '') : null) ?? sel.name;
  });
  const { tabId, repoId } = useRepoContext();
  const wipCtx = useWipCtx();
  // Discard all is off during a merge or rebase (spec #2 §7.2).
  const midOp = useRepoView((s) => {
    const sel = s.panel?.selection;
    return sel?.kind === 'wip' && !!s.graph.worktrees.find((w) => w.path === sel.worktree)?.inProgress;
  });
  const committing = useCommitting(wipCtx?.repoId ?? -1, wipCtx?.worktree ?? '');
  // An armed Discard all says how many files, of which worktree: a different count or worktree
  // disarms it.
  const ref = useRef<HTMLElement>(null);
  useDisarmOnChange(ref, `${count}\0${selection?.kind === 'wip' ? selection.worktree : ''}`);
  if (selection?.kind !== 'wip') return null;
  return (
    // Armed, Discard all grows rightwards over the header's text, which dims (board B).
    <header ref={ref} className="wip-header panel-bar" data-testid="wip-header" data-arm-dim="">
      {/* Left, centre, right: the centre stays centred whatever the sides hold. */}
      {/* --- 2B T9: Discard all (it arms in place, spec §ui confirms) --- */}
      {wipCtx && (
        <span className="wip-head-left" data-arm-grow="right">
          <ActionIcon label="Discard all" tip={committing ? COMMIT_QUEUED : midOp ? 'Abort instead' : count === 0 ? 'Nothing to discard' : 'Discard all changes'} icon={Trash2} danger disabled={committing || midOp || count === 0} onClick={() => void discardAll(wipCtx, count)} />
        </span>
      )}
      {/* --- end 2B T9 --- */}
      <span className="wip-head-centre">
      <span>{count} file {count === 1 ? 'change' : 'changes'}</span>
      {branch && <>{' '}<span>on</span>{' '}<HoverTooltip content={`Worktree ${selection.name}`} disabled={!selection.name}><span className="wip-branch">{branch}</span></HoverTooltip></>}
      </span>
      <span className="wip-head-right">
      {/* --- 2C T13: stash this worktree's changes --- */}
      {tabId && count > 0 && (
        <HoverTooltip content="Stash every change, named from the WIP message">
          <button type="button" className="icon-button" aria-label="Stash" onClick={() => void stashPushFor({ tabId, repoId, worktree: selection.worktree })}>
            <StashIcon size={14} aria-hidden />
          </button>
        </HoverTooltip>
      )}
      {/* --- end 2C T13 --- */}
      </span>
    </header>
  );
}
