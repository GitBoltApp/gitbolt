import { useEffect, useState } from 'react';
import type { LastPushPayload } from '../api/gen/LastPushPayload';
import { relativeTime } from '../format/relative';
import { shortSha } from '../format/sha';
import { getLastPush } from './lastPushCache';
import type { SideItem } from './model';

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
  const summary = item.kind === 'local' || item.kind === 'remote' ? item.branch.summary : item.kind === 'stash' ? item.stash.message : '';
  const author = item.kind === 'local' || item.kind === 'remote' ? item.branch.author : '';
  if (item.kind === 'worktree') {
    const w = item.worktree;
    return (
      <div className="hover-card" role="tooltip" aria-label={`${item.name} details`} style={{ top, left }}>
        <div className="hc-name">{w.name}</div>
        <div className="hc-summary" style={{ wordBreak: 'break-all' }}>{w.path}</div>
        <div className="hc-meta">{w.branch ? `Branch: ${w.branch}` : `Detached${w.head ? ` at ${shortSha(w.head)}` : ''}`}</div>
        {w.head && w.branch && <div className="hc-meta">HEAD {shortSha(w.head)}</div>}
        <div className="hc-meta">{[w.isMain ? 'Main checkout' : 'Linked worktree', w.isCurrent ? 'current' : ''].filter(Boolean).join(' · ')}</div>
      </div>
    );
  }
  return (
    <div className="hover-card" role="tooltip" aria-label={`${item.name} details`} style={{ top, left }}>
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
    </div>
  );
}
