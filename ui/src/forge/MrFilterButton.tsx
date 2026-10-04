import { Check, ListFilter, type LucideIcon } from 'lucide-react';
import { useRef } from 'react';
import type { MrFilter } from '../api/gen/MrFilter';
import { useAppState } from '../app/state';
import { openMenuAt } from '../menu/menuStore';
import type { MenuRow } from '../menu/types';
import { HoverTooltip } from '../ui/HoverTooltip';
import { mrSectionLabel } from './labels';
import { refreshMrList } from './mrSection';
import { patchForge, useTabForgeField } from './mrStore';

/** No icon: the unchosen rows line up with the chosen one's check (as ui/Select does). */
const Blank = (() => null) as unknown as LucideIcon;
const OPTIONS: ReadonlyArray<readonly [MrFilter, string, string]> = [
  ['mine', 'Mine', 'Show the open ones you opened'],
  ['reviewRequested', 'Review requested', 'Show the open ones waiting for your review'],
  ['all', 'All', 'Show every open one'],
];

/** The section header's filter (spec #4 §2: Mine / Review requested / All), kept per repository. */
export function MrFilterButton({ tabId, path }: { tabId: string; path: string }) {
  const filter = useTabForgeField(tabId, 'filter');
  const kind = useTabForgeField(tabId, 'kind');
  const updateRepo = useAppState((s) => s.updateRepo);
  const btn = useRef<HTMLButtonElement>(null);
  if (!kind) return null;
  const current = OPTIONS.find(([v]) => v === filter)?.[1] ?? 'All';
  const label = `Filter ${mrSectionLabel(kind).toLowerCase()}: ${current}`;
  const pick = (v: MrFilter) => {
    updateRepo(path, (r) => ({ ...r, mrFilter: v }));
    patchForge(tabId, { filter: v });
    void refreshMrList(tabId);
  };
  const rows = (): MenuRow[] => OPTIONS.map(([v, l, tip]) => ({ kind: 'action', id: `mrFilter.${v}`, label: l, icon: v === filter ? Check : Blank, tooltip: tip, run: () => pick(v) }));
  return (
    <HoverTooltip content={label}>
      <button
        ref={btn}
        type="button"
        className={`icon-button sb-head-action${filter === 'all' ? '' : ' is-on'}`}
        aria-label={label}
        aria-haspopup="menu"
        onClick={(e) => {
          e.stopPropagation();
          if (btn.current) openMenuAt(btn.current, rows(), `mrFilter.${filter}`, rows, label);
        }}
      >
        <ListFilter size={13} aria-hidden />
      </button>
    </HoverTooltip>
  );
}
