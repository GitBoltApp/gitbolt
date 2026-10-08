import { Check, Keyboard, LoaderCircle, TriangleAlert, ZoomIn } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAppInfo } from '../app/appInfo';
import { useOps, type OpInfo } from '../app/ops';
import { useRuntime } from '../app/runtime';
import { useAppState } from '../app/state';
import { rebaseStatus } from '../integrate/rebasing';
import { runAction } from '../app/actions';
import { openMenuAt } from '../menu/menuStore';
import type { MenuRow } from '../menu/types';
import { QueueChip } from '../queue/QueueChip';
import { HoverTooltip } from '../ui/HoverTooltip';
import { setZoom, useZoom, ZOOM_STEPS } from '../ui/zoom';
import { UpdatePill } from '../updates/UpdatePill';
import './statusbar.css';
import { displayChord, resolveChord } from '../ui/platformKeys';

/** Spec §12.3: the zoom steps, the current one first in focus. */
function zoomRows(current: number): MenuRow[] {
  return ZOOM_STEPS.map((z) => ({
    kind: 'action', id: `zoom.${z}`, label: `${z}%`, icon: z === current ? Check : ZoomIn,
    tooltip: z === current ? 'The current zoom' : `Zoom to ${z}%`, shortcut: z === 100 ? resolveChord('Mod+0') : undefined, run: () => setZoom(z),
  }));
}

/** The running network op the bar shows: the first clone (rarely more than one runs). A fetch
 * shows here only when it's the user's and slow (below); a background one is only logged (K30). */
const firstOp = (ops: ReturnType<typeof useOps.getState>['ops']) => Object.values(ops).find((o) => o.kind === 'clone');
/** The user's running fetch (or the background one a user's Fetch waits on). */
const userFetch = (ops: ReturnType<typeof useOps.getState>['ops']) => Object.values(ops).find((o) => o.kind === 'fetch' && (o.interactive || o.shown));

/** A user's running write (spec #2 §3.3): the bar shows it after `SLOW_FETCH_MS`, with Cancel. */
const userWrite = (ops: ReturnType<typeof useOps.getState>['ops']) => Object.values(ops).find((o) => o.interactive && o.kind !== 'fetch' && o.kind !== 'clone');
const capitalized = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** How long a user's fetch runs on its button alone (K30) before the bar shows its progress and a
 * Cancel (K96: a stuck remote can be stopped). Most fetches are done well before. */
export const SLOW_FETCH_MS = 2000;

/** `op`, once it has run `SLOW_FETCH_MS`; else `undefined`. */
function useSlow(op: OpInfo | undefined): OpInfo | undefined {
  const [slowId, setSlowId] = useState<number | null>(null);
  const id = op?.op;
  const startedAt = op?.startedAt;
  useEffect(() => {
    if (id === undefined || startedAt === undefined) return;
    const t = setTimeout(() => setSlowId(id), Math.max(0, startedAt + SLOW_FETCH_MS - Date.now()));
    return () => clearTimeout(t);
  }, [id, startedAt]);
  return op && op.op === slowId ? op : undefined;
}

/** How long an autostash step runs before the slow-write status names it (spec #2 §6: a big
 * worktree's stash, or a slow clean/smudge filter). */
export const SLOW_STASH_MS = 60_000;
const STEP_TEXT = { saving: 'Saving your changes…', restoring: 'Restoring your changes…', restoringFiles: 'Restoring files…' } as const;

/** The write's status text: its label, or after `SLOW_STASH_MS` of one step, that step. */
function useWriteText(op: OpInfo | undefined): string | undefined {
  const [slowAt, setSlowAt] = useState<number | null>(null);
  const at = op?.stash?.at;
  useEffect(() => {
    if (at === undefined) return;
    const t = setTimeout(() => setSlowAt(at), Math.max(0, at + SLOW_STASH_MS - Date.now()));
    return () => clearTimeout(t);
  }, [at]);
  if (!op) return undefined;
  // --- 2D T18: a rebase's counter, from its first step (Deviation 11) ---
  const rebasing = rebaseStatus(op);
  if (rebasing && !(op.stash && op.stash.at === slowAt)) return rebasing;
  // --- end 2D T18 ---
  return op.stash && op.stash.at === slowAt ? STEP_TEXT[op.stash.step] : op.kind === 'commit' ? 'Committing…' : `${capitalized(op.label)}…`;
}

/**
 * The status bar (spec §6.5), in the app's `statusBar` slot: zoom, a running clone or a slow fetch
 * of the user's (or the auth prompt one waits on) with Cancel, the active tab's fetch-skipped
 * warning, the update pill (`updates/`), the Keyboard Shortcuts button, git's version and GitBolt's. (The notification bell is in the tab bar.)
 */
export function StatusBar() {
  const zoom = useZoom((s) => s.zoom);
  const activeTab = useAppState((s) => s.profile.activeTab);
  const skipped = useRuntime((s) => (activeTab ? s.tabs[activeTab]?.fetchSkipped ?? null : null));
  const task = useOps((s) => firstOp(s.ops));
  const fetching = useSlow(useOps((s) => userFetch(s.ops)));
  const write = useOps((s) => userWrite(s.ops));
  const slowWrite = useSlow(write);
  // A rebase with a step shows at once (2D T18); other writes wait out SLOW_FETCH_MS.
  const writing = write && rebaseStatus(write) ? write : slowWrite;
  const writeText = useWriteText(writing);
  const prompt = useOps((s) => s.prompts[0]);
  const git = useAppInfo((s) => s.info?.gitVersion);
  const version = useAppInfo((s) => s.info?.appVersion);
  const build = useAppInfo((s) => s.info?.build);
  useEffect(() => { void useAppInfo.getState().load().catch((e: unknown) => console.warn('[gitbolt] app info', e)); }, []);
  const cancel = (op: number) => { void api.cancelOp(op).catch(() => {}); };
  return (
    <footer className="status-bar">
      <HoverTooltip content={`Zoom (${displayChord('Mod+=')} / ${displayChord('Mod+-')})`}>
        <button type="button" className="sb-item sb-button" aria-label={`Zoom ${zoom}%`} aria-haspopup="menu" onClick={(e) => openMenuAt(e.currentTarget, zoomRows(zoom), `zoom.${zoom}`, undefined, 'Zoom')}>
          {zoom}%
        </button>
      </HoverTooltip>
      <QueueChip />
      {prompt ? (
        <span className="sb-item sb-auth">
          Waiting for authentication…
          <button type="button" className="sb-link" onClick={() => cancel(prompt.op)}>Cancel</button>
        </span>
      ) : task ? (
        <span className="sb-item sb-task">
          <LoaderCircle size={12} className="sb-spin" aria-hidden />
          {`Cloning…${task.percent !== null ? ` ${task.percent}%` : ''}`}
          <button type="button" className="sb-link" onClick={() => cancel(task.op)}>Cancel</button>
        </span>
      ) : fetching ? (
        <span className="sb-item sb-task">
          <LoaderCircle size={12} className="sb-spin" aria-hidden />
          {`Fetching ${fetching.label}…${fetching.percent !== null ? ` ${fetching.percent}%` : ''}`}
          <button type="button" className="sb-link" onClick={() => cancel(fetching.op)}>Cancel</button>
        </span>
      ) : writing ? (
        <span className="sb-item sb-task" data-testid="status-write">
          <LoaderCircle size={12} className="sb-spin" aria-hidden />
          {writeText}
          {/* During an autostash step, Cancel is a Stop: git's step is stopped, and the
              changes stay in the stash, whose banner then offers Apply (spec #2 §6). */}
          <button type="button" className="sb-link" onClick={() => cancel(writing.op)}>
            {writing.stash ? `Stop — your changes stay in stash ${writing.stash.message}` : 'Cancel'}
          </button>
        </span>
      ) : null}
      {skipped && <span className="sb-item sb-warn"><TriangleAlert size={12} aria-hidden /> {skipped}</span>}
      <span className="sb-spacer" />
      <UpdatePill />
      <HoverTooltip content={`Keyboard shortcuts (${displayChord('Mod+/')})`}>
        <button type="button" className="sb-item sb-button" aria-label="Keyboard shortcuts" onClick={() => runAction('help.shortcuts')}>
          <Keyboard size={12} aria-hidden />
        </button>
      </HoverTooltip>
      <span className="sb-item">git {git ?? '…'}</span>
      {build ? (
        <HoverTooltip content={`Build ${build}`}>
          <span className="sb-item sb-version">GitBolt {version ?? '…'}</span>
        </HoverTooltip>
      ) : <span className="sb-item sb-version">GitBolt {version ?? '…'}</span>}
    </footer>
  );
}
