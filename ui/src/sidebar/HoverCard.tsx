import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useCardPlacement } from '../ui/HoverTooltip';
import type { LastPushPayload } from '../api/gen/LastPushPayload';
import { relativeTime } from '../format/relative';
import { shortSha } from '../format/sha';
import { getLastPush } from './lastPushCache';
import type { SideItem } from './model';
import { TagTip } from '../tags/TagTip';
// --- 4B T10 ---
import { useRepoContext } from '../app/repoContext';
import { BranchMrBlock } from '../forge/MrBadge';
// --- end 4B T10 ---
// --- 4B T11 ---
import { MrCardLive } from '../forge/MrCardLive';
// --- end 4B T11 ---

/** The card's box: placed beside the row, kept inside the window (moved up to fit, `max-height` and
 * scrolling when taller than the window), and re-placed when its content grows (an MR's detail). */
export function CardShell({ label, top, left, children }: { label: string; top: number; left: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const anchor = useMemo(() => ({ left, top, bottom: top }), [left, top]);
  useCardPlacement(ref, anchor, 'top', 0);
  return <div ref={ref} className="hover-card" role="tooltip" aria-label={label} style={{ top, left }}>{children}</div>;
}

/**
 * Spec §6.4 hover card: tip, author, date, ahead/behind, last push (or last seen on remote).
 * Shows immediately on hover, with no delay (the user's ruling, amendment 3); "Last push" is the
 * one part that waits on the backend, so it shows a loading placeholder until that answers.
 *
 * Fix round 1, item 7: a fast pointer sweep across many rows must not fire one `lastPush`
 * request per row. Two things do that: `lastPushCache` (per repo + remote ref, in-flight and
 * resolved-value dedupe), and the one frame of grace below — a row the pointer only swept past
 * has its `remoteRef` change (or unmounts) before that frame, so its request is never sent;
 * only the row the pointer settles on asks the backend. The card (and "Loading…") still show at
 * once; only the request itself waits.
 */
export function HoverCard({ item, repoId, top, left }: { item: SideItem; repoId: number; top: number; left: number }) {
  const { tabId } = useRepoContext(); // 4B T10
  const [push, setPush] = useState<LastPushPayload | null | undefined>(undefined);
  const remoteRef = item.kind === 'local' ? item.branch.upstream : item.kind === 'remote' ? item.branch.fullName : null;
  useEffect(() => {
    let live = true;
    setPush(undefined);
    if (!remoteRef) {
      setPush(null);
      return;
    }
    const raf = requestAnimationFrame(() => {
      void getLastPush(repoId, remoteRef).then((p) => { if (live) setPush(p); }, () => { if (live) setPush(null); });
    });
    return () => {
      live = false;
      cancelAnimationFrame(raf);
    };
  }, [repoId, remoteRef]);
  // --- 4B T11: an MR/PR row's card ---
  if (item.kind === 'mr') {
    return (
      <CardShell label={`${item.name} details`} top={top} left={left}>
        <MrCardLive tabId={tabId} kind={item.forge} mr={item.mr} hint="Click to open" />
      </CardShell>
    );
  }
  // --- end 4B T11 ---
  const summary = item.kind === 'local' || item.kind === 'remote' ? item.branch.summary : item.kind === 'stash' ? item.stash.message : '';
  const author = item.kind === 'local' || item.kind === 'remote' ? item.branch.author : '';
  if (item.kind === 'worktree') {
    const w = item.worktree;
    return (
      <CardShell label={`${item.name} details`} top={top} left={left}>
        <div className="hc-name">{w.name}</div>
        <div className="hc-summary" style={{ wordBreak: 'break-all' }}>{w.path}</div>
        <div className="hc-meta">{w.branch ? `Branch: ${w.branch}` : `Detached${w.head ? ` at ${shortSha(w.head)}` : ''}`}</div>
        {w.head && w.branch && <div className="hc-meta">HEAD {shortSha(w.head)}</div>}
        <div className="hc-meta">{[w.isMain ? 'Main checkout' : 'Linked worktree', w.isCurrent ? 'current' : ''].filter(Boolean).join(' · ')}</div>
      </CardShell>
    );
  }
  if (item.kind === 'tag') {
    // UX round 3, M.2: an annotated tag's message, tagger and date; a lightweight tag's commit.
    return (
      <CardShell label={`${item.name} details`} top={top} left={left}>
        <div className="hc-name">{item.name}</div>
        <div className="hc-summary"><TagTip annotation={item.tag.annotation} sha={item.tag.target} /></div>
      </CardShell>
    );
  }
  return (
    <CardShell label={`${item.name} details`} top={top} left={left}>
      <div className="hc-name">{item.name}</div>
      {summary && <div className="hc-summary">{summary}</div>}
      <div className="hc-meta">{author && `${author} · `}{item.time ? relativeTime(item.time) : ''}</div>
      {item.kind === 'local' && item.branch.upstream && (
        <div className="hc-meta">{item.branch.gone ? 'Upstream is gone' : `${item.branch.ahead}↑ ${item.branch.behind}↓ vs ${item.branch.upstream.replace(/^refs\/remotes\//, '')}`}</div>
      )}
      {remoteRef && (
        <div className="hc-meta">
          {push === undefined ? 'Loading…' : push === null ? 'Never seen on the remote' : push.kind === 'push' ? `Last push: ${relativeTime(push.time)}` : `Last seen on remote: ${relativeTime(push.time)}`}
        </div>
      )}
      {/* --- 4B T10: the branch's MR/PR --- */}
      {item.kind === 'local' && <BranchMrBlock tabId={tabId} upstream={item.branch.upstream} />}
      {/* --- end 4B T10 --- */}
    </CardShell>
  );
}
