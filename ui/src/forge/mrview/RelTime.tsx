import type { MouseEvent } from 'react';
import type { DateFormat } from '../../api/gen/DateFormat';
import { useAppState } from '../../app/state';
import { formatDate } from '../../format/date';
import { relativeTime } from '../../format/relative';
import { HoverTooltip } from '../../ui/HoverTooltip';

/** The local time zone's short name at `d` ("EDT", "GMT+2"). */
export function zoneName(d: Date): string {
  return new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(d).find((p) => p.type === 'timeZoneName')?.value ?? '';
}

/** A relative date's tooltip: the precise date and time in the user's date format, with the time
 * zone (none of the formats has one). */
export function fullDate(unixSeconds: number, fmt: DateFormat, zone: (d: Date) => string = zoneName): string {
  const tz = zone(new Date(unixSeconds * 1000));
  return tz ? `${formatDate(unixSeconds, fmt)} ${tz}` : formatDate(unixSeconds, fmt);
}

/**
 * A relative date in the MR/PR view ("2 weeks ago"), its precise date and time on hover. `prefix`
 * goes before it ("updated"); `onContextMenu`: a comment's date, whose menu copies its link;
 * `onOpenMenu`: the same menu on a click, the date a button that underlines on hover.
 */
export function RelTime({ at, prefix, className = 'mr-when', onContextMenu, onOpenMenu }: { at: number; prefix?: string; className?: string; onContextMenu?: (e: MouseEvent<HTMLElement>) => void; onOpenMenu?: (el: HTMLElement) => void }) {
  const fmt = useAppState((s) => s.settings.dateFormat);
  const text = `${prefix ? `${prefix} ` : ''}${relativeTime(at)}`;
  if (onOpenMenu) {
    return (
      <HoverTooltip content={() => fullDate(at, fmt)}>
        <button type="button" className={`${className} mr-when-btn`} aria-haspopup="menu" onContextMenu={onContextMenu} onClick={(e) => onOpenMenu(e.currentTarget)}>{text}</button>
      </HoverTooltip>
    );
  }
  return (
    <HoverTooltip content={() => fullDate(at, fmt)}>
      <span className={className} onContextMenu={onContextMenu}>{text}</span>
    </HoverTooltip>
  );
}
