import { X } from 'lucide-react';
import { useEffect } from 'react';
import { api } from '../api/client';
import type { Banner } from '../api/gen/Banner';
import { selectCommit } from '../app/graphNav';
import { useRepoContext } from '../app/repoContext';
import type { TabSlotProps } from '../app/slots';
import { toastActionError } from '../debug/errorToast';
import { confirmAction } from '../ui/ConfirmDialog';
import { HoverTooltip } from '../ui/HoverTooltip';
import { useToast } from '../ui/toast';
import { journalKey, loadJournal, useJournal } from '../undo/store';
import { runWrite, type WriteCtx } from '../write/client';
import { writeErrorContext } from '../write/indexLock';
import './banner.css';

const NONE: Banner[] = [];
const capitalized = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Spec #2 §6.4 and §5.1's wording. */
export function bannerText(b: Banner): string {
  switch (b.kind) {
    case 'autostashRefused':
      return `Your changes from before ${b.label} are in stash "${b.stashMessage}": they conflict with ${b.target ?? 'it'}.`;
    case 'autostashConflicts':
      return `Your restored changes conflict in ${b.files} ${b.files === 1 ? 'file' : 'files'}; resolve them in Conflicted. The stash is kept until you drop it.`;
    case 'autostashPartial':
      return `Your changes from before ${b.label} were partly restored; the stash still has everything.`;
    case 'autostashStopped':
      return `${capitalized(b.label)} didn't run: saving your changes was stopped. They're in stash "${b.stashMessage}".`;
    case 'recovery':
      return `GitBolt stopped during ${b.label}. Your changes are safe in ${b.snapshot ? 'a snapshot' : 'the autostash'}.`;
  }
}

/** A binary conflict keeps only the worktree's version of those files: say so before Drop. */
const BINARY_DROP = {
  title: 'Drop the stash?',
  body: 'Some conflicted files are binary: only the current version of those is kept, and the stash is the only copy of yours. Drop it anyway?',
  confirmLabel: 'Drop stash',
  danger: true,
};

/** × on a recovery snapshot drops the only pointer to it (it's dangling, not in the graph, so
 * there is no Show): ask first (2A final M8). */
const dropSnapshot = (label: string) => ({
  title: 'Dismiss without restoring?',
  body: `The snapshot is the only copy of your changes from before ${label}. Once dismissed, GitBolt can't restore them.`,
  confirmLabel: 'Dismiss',
  danger: true,
});

function Row({ b, w }: { b: Banner; w: WriteCtx }) {
  // Apply (a kept stash) or Restore (a recovery entry's snapshot); its questions are runWrite's.
  const apply = () => runWrite(w, (_, asked) => api.applyKeptStash(w.repoId, w.worktree, Number(b.entry), asked.withoutIndex, asked.autostash));
  const dismiss = async (dropStash: boolean) => {
    if (dropStash && b.binary && !(await confirmAction(BINARY_DROP))) return;
    if (!dropStash && restore && !(await confirmAction(dropSnapshot(b.label)))) return;
    try {
      useJournal.getState().set(w.repoId, w.worktree, await api.dismissBanner(w.repoId, w.worktree, Number(b.entry), dropStash));
    } catch (e) {
      toastActionError(e, writeErrorContext(w.repoId, { retry: () => dismiss(dropStash) }));
    }
  };
  const stash = b.stash;
  const restore = b.kind === 'recovery' && b.snapshot;
  const show = () => {
    if (stash && !selectCommit(w.tabId, stash)) useToast.getState().show('Not in the loaded history');
  };
  const applies = b.kind === 'autostashRefused' || b.kind === 'autostashPartial' || b.kind === 'autostashStopped' || (b.kind === 'recovery' && !b.snapshot && !!stash);
  return (
    <div className={`banner banner-${b.kind}`} role="status">
      <span className="banner-text">{bannerText(b)}</span>
      {applies && <button type="button" className="banner-action" onClick={() => void apply()}>Apply</button>}
      {restore && <button type="button" className="banner-action" onClick={() => void apply()}>Restore</button>}
      {stash && <button type="button" className="banner-action" onClick={show}>Show</button>}
      {b.canDrop && <button type="button" className="banner-action" onClick={() => void dismiss(true)}>Drop stash</button>}
      <HoverTooltip content={stash ? 'Dismiss: the stash stays' : restore ? 'Dismiss: the snapshot is dropped' : 'Dismiss'}>
        <button type="button" className="icon-button banner-close" aria-label="Dismiss" onClick={() => void dismiss(false)}><X size={13} aria-hidden /></button>
      </HoverTooltip>
    </div>
  );
}

/** The tab's `banner` slot (spec #2 §3.7): autostash and crash-recovery notices from the
 * worktree's journal (its kept stashes and recovery entries). It loads the journal when the tab
 * shows; events and write results keep it current. */
export function Banners({ tab }: TabSlotProps) {
  const ctx = useRepoContext();
  const banners = useJournal((s) => s.states[journalKey(ctx.repoId, ctx.path)]?.banners ?? NONE);
  useEffect(() => {
    if (ctx.repoId >= 0) void loadJournal(ctx.repoId, ctx.path);
  }, [ctx.repoId, ctx.path]);
  if (banners.length === 0) return null;
  const w: WriteCtx = { tabId: tab.id, repoId: ctx.repoId, worktree: ctx.path };
  return (
    <div className="banners" role="region" aria-label="Notices">
      {banners.map((b) => <Row key={`${b.kind}-${b.entry}`} b={b} w={w} />)}
    </div>
  );
}
