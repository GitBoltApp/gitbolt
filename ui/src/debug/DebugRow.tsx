import { Check, ChevronRight, CircleSlash, Copy, LoaderCircle, X } from 'lucide-react';
import { useEffect, useState, type ReactNode, type Ref } from 'react';
import { copyAndSay, relativeTime, seconds } from '../app/activityLog';
import './debug.css';

export type RowStatus = 'ok' | 'failed' | 'cancelled' | 'skipped' | 'running';

export interface Pill {
  text: string;
  title?: string;
  /** A pill in the monospace face (an action id, a folder). */
  mono?: boolean;
  /** Red: an exit code, a non-ok outcome. */
  bad?: boolean;
}

const STATUS_ICON = { ok: Check, failed: X, cancelled: CircleSlash, skipped: CircleSlash, running: LoaderCircle } as const;
const STATUS_LABEL: Record<RowStatus, string> = { ok: 'ok', failed: 'failed', cancelled: 'cancelled', skipped: 'skipped', running: 'running' };

/** 24-hour HH:MM:SS: the time column, the same width on every row. */
export const clockTime = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

interface Props {
  status: RowStatus;
  at: number;
  now: number;
  label: ReactNode;
  /** The whole label, as the label's tooltip (it's truncated to one line). */
  title?: string;
  pills?: Pill[];
  ms: number;
  /** The entry as plain text, for its Copy button. */
  copy: () => string;
  /** The expanded part (command, output), rendered only while expanded; none means no chevron. */
  detail?: (() => ReactNode) | null;
  /** Expanded at mount, and again whenever this turns true (an error, the focused entry). */
  defaultOpen?: boolean;
  className?: string;
  liRef?: Ref<HTMLLIElement>;
  current?: boolean;
  dataOp?: number;
}

/**
 * One Debug-modal entry (the Activity, Commands and Actions tabs): a compact row of aligned columns
 * (status, time, label, pills, duration, Copy on hover) that expands into a selectable monospace
 * block on click.
 */
export function DebugRow({ status, at, now, label, title, pills = [], ms, copy, detail, defaultOpen = false, className = '', liRef, current, dataOp }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => { if (defaultOpen) setOpen(true); }, [defaultOpen]);
  const Icon = STATUS_ICON[status];
  const toggle = detail ? () => setOpen((o) => !o) : undefined;
  return (
    <li ref={liRef} className={`debug-row ${className} ${status}${open && detail ? ' open' : ''}`} aria-current={current || undefined} data-op={dataOp}>
      <div className="debug-row-main" onClick={toggle}>
        {detail
          ? <button type="button" className="debug-chevron" aria-expanded={open} aria-label={open ? 'Hide details' : 'Show details'}><ChevronRight size={13} aria-hidden /></button>
          : <span className="debug-chevron" />}
        <span className={`debug-status ${status}`} title={STATUS_LABEL[status]}><Icon size={14} aria-label={STATUS_LABEL[status]} /></span>
        <time className="debug-time" dateTime={new Date(at).toISOString()} title={`${new Date(at).toLocaleString()} · ${relativeTime(at, now)}`}>{clockTime(at)}</time>
        <span className="debug-label" title={title}>{label}</span>
        <span className="debug-pills">
          {pills.map((p, i) => <span key={i} className={`debug-pill${p.mono ? ' mono' : ''}${p.bad ? ' bad' : ''}`} title={p.title}>{p.text}</span>)}
        </span>
        <span className="debug-ms">{seconds(ms)}</span>
        <button type="button" className="icon-button debug-copy" aria-label="Copy entry" onClick={(ev) => { ev.stopPropagation(); void copyAndSay(copy()); }}><Copy size={13} /></button>
      </div>
      {open && detail && <div className="debug-row-detail">{detail()}</div>}
    </li>
  );
}

/** A filter-bar checkbox: box and label on one line, centered. */
export function DebugCheck({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return <label className="debug-check"><input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />{label}</label>;
}
