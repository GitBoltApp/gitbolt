import { CircleStop, ListX, Play, X } from 'lucide-react';
import { useEffect } from 'react';
import { api } from '../api/client';
import type { QueueStatePayload } from '../api/gen/QueueStatePayload';
import { useRuntime } from '../app/runtime';
import { useAppState } from '../app/state';
import { openMenuAt } from '../menu/menuStore';
import type { MenuRow } from '../menu/types';
import { HoverTooltip } from '../ui/HoverTooltip';
import { chipText, IDLE, isIdle, loadQueue, useQueue } from './store';
import './queue.css';

const quiet = (p: Promise<unknown>) => { void p.catch((e: unknown) => console.warn('[gitbolt] queue', e)); };

/** The chip's list (spec #2 §3.6): the running item with Cancel, each queued item with ×, and
 * Resume / Clear after a stop. */
function rows(repo: number, q: QueueStatePayload): MenuRow[] {
  const out: MenuRow[] = [];
  if (q.running) {
    const { op, label } = q.running;
    out.push({ kind: 'action', id: 'queue.running', label: `Cancel ${label}`, icon: CircleStop, tooltip: 'Stop the running operation', run: () => quiet(api.cancelOp(op)) });
  }
  for (const item of q.queued) {
    out.push({ kind: 'action', id: `queue.${item.id}`, label: `Remove ${item.label}`, icon: X, tooltip: q.stopped ? 'Not run: drop it from the queue' : 'Queued: drop it from the queue', run: () => quiet(api.queueRemove(repo, item.id)) });
  }
  if (q.stopped) {
    out.push(
      { kind: 'separator' },
      { kind: 'action', id: 'queue.resume', label: 'Resume', icon: Play, tooltip: 'Run the items that didn\'t run, each against the repository as it is now', run: () => quiet(api.queueResume(repo)) },
      { kind: 'action', id: 'queue.clear', label: 'Clear', icon: ListX, tooltip: 'Drop the items that didn\'t run', run: () => quiet(api.queueClear(repo)) },
    );
  }
  return out;
}

/** The status bar's queue chip (spec #2 §3.6), for the active tab's repository; hidden when idle. */
export function QueueChip() {
  const activeTab = useAppState((s) => s.profile.activeTab);
  const repo = useRuntime((s) => (activeTab ? s.tabs[activeTab]?.repo?.id : undefined));
  const q = useQueue((s) => (repo === undefined ? undefined : s.byRepo[repo]));
  useEffect(() => {
    if (repo !== undefined) void loadQueue(repo);
  }, [repo]);
  if (repo === undefined || !q || isIdle(q)) return null;
  const latest = () => rows(repo, useQueue.getState().byRepo[repo] ?? IDLE);
  const text = chipText(q);
  return (
    <HoverTooltip content="The action queue: what runs now and what's next">
      <button type="button" className={`sb-item sb-button sb-queue${q.stopped ? ' stopped' : ''}`} aria-label={text} aria-haspopup="menu" onClick={(e) => openMenuAt(e.currentTarget, latest(), undefined, latest, 'Action queue')}>
        {text}
      </button>
    </HoverTooltip>
  );
}
