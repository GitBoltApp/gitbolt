import { GitBranch, Lock, Plus, X } from 'lucide-react';
import { useState, type MouseEvent, type ReactNode } from 'react';
import { openContextMenu, openMenuAt } from '../menu/menuStore';
import { buildMenu } from '../menu/registry';
import type { MenuRow } from '../menu/types';
import { HoverTooltip } from '../ui/HoverTooltip';
import type { ChipTarget } from './chipMenu';
import { startChipDrag, useChipDrag } from './chipDrag';
import { laneStyle, useChipColor } from './colors';
import { addChip, chipRow, moveChip, rebasedRow, removeChip, type EditorChip, type EditorState, type Grouping } from './model';
import { editState, sessionOf } from './session';

/** A chip's tooltip: what it does. Its full name is its hover expansion (UX2 E.1). */
const tip = (note: string): ReactNode => <div className="irebase-tip-note">{note}</div>;

/** Right-click on a chip: the chip menu (UX R1.3). */
const chipMenuRows = (tabId: string, branch: string) => buildMenu<ChipTarget, object>('chip', { tabId, branch }, {});
const chipMenu = (tabId: string, branch: string) => (e: MouseEvent) => openContextMenu(e, () => chipMenuRows(tabId, branch));

/** One chip of a row: a movable one (`chip`), or the read-only rebased branch's or base's. */
export interface ChipItem { branch: string; kind: 'base' | 'rebased' | 'chip'; chip?: EditorChip; color: string | undefined }

/* UX2 E.2: the chip column (editor.css --irebase-chips-w, 220 px) shows its chips at a readable
   minimum (READABLE characters, ellipsized) or a "+N" pill for the rest. Estimates of the 12 px
   chip, on the generous side of the CSS (6ch + padding + ×), so a chip shown is never clipped. */
export const READABLE = 6;
const CHAR_W = 7.5;
const CHIP_PAD = 10;
const X_W = 17;
const GAP = 6;
const PILL_W = 30;
/** The column less its "+" (16 px and a 3 px gap); the base's row has no "+". */
export const LIST_W = 201;
export const BASE_LIST_W = 220;
const hasX = (it: ChipItem) => it.kind === 'chip';
const minWidth = (it: ChipItem) => CHIP_PAD + Math.min(it.branch.length, READABLE) * CHAR_W + (hasX(it) ? X_W : 0);

/** How many of `items` (in order) the column shows: all when they fit at their readable minimum,
 * else as many as fit beside the "+N" pill. */
export function chipsShown(items: readonly ChipItem[], avail: number): number {
  const widths = items.map(minWidth);
  const total = (k: number) => widths.slice(0, k).reduce((a, b) => a + b, 0) + GAP * Math.max(0, k - 1);
  if (total(items.length) <= avail) return items.length;
  let k = items.length - 1;
  while (k > 0 && total(k) + GAP + PILL_W > avail) k--;
  return k;
}

const noteOf = (it: ChipItem): string => {
  if (it.kind === 'base') return 'The base: read-only';
  if (it.kind === 'rebased') return 'Ends here: git moves it';
  const c = it.chip!;
  return c.locked ? `Can't move: ${c.locked}` : c.deleted ? 'Will be deleted when the rebase completes' : 'Drag it to another commit to move it';
};

const kindClass = (it: ChipItem): string => {
  if (it.kind !== 'chip') return `is-${it.kind}`;
  const c = it.chip!;
  return [c.deleted ? 'is-deleted' : '', c.locked ? 'is-locked' : '', !c.locked && !c.deleted ? 'is-free' : ''].filter(Boolean).join(' ');
};

/** A chip at its full name, every control of the chip in it (drag, ×, menu): the hover expansion
 * of a truncated chip, and the "+N" pill's list. Its × doubles the chip's own (`aria-hidden`). */
function FullChip({ tabId, item }: { tabId: string; item: ChipItem }) {
  const c = item.chip;
  const free = !!c && !c.locked && !c.deleted;
  return (
    <span
      className={`irebase-chip-full ${kindClass(item)}`}
      style={laneStyle(item.color)}
      data-branch={item.branch}
      onContextMenu={chipMenu(tabId, item.branch)}
      onPointerDown={free ? (e) => startChipDrag(e, item.branch, (branch, row) => editState(tabId, (s) => moveChip(s, branch, row))) : undefined}
    >
      <span className="irebase-chip-full-name">{item.branch}</span>
      {c && (c.locked ? <Lock size={11} aria-hidden="true" /> : (
        <button type="button" tabIndex={-1} className="irebase-chip-full-x" aria-label={c.deleted ? `Keep ${c.branch}` : `Delete ${c.branch} when the rebase completes`} onClick={(e) => { e.stopPropagation(); editState(tabId, (s) => removeChip(s, c.branch)); }}>
          <X size={11} aria-hidden="true" />
        </button>
      ))}
    </span>
  );
}

/** A chip in the column: its name (ellipsized), its ×; hovering the name expands it to its full
 * name in place, over its neighbours (UX2 E.1: an overlay, so the row never shifts). */
function Chip({ tabId, item }: { tabId: string; item: ChipItem }) {
  const c = item.chip;
  const free = !!c && !c.locked && !c.deleted;
  const dragged = useChipDrag((x) => !!c && x.drag?.branch === c.branch);
  const dragging = useChipDrag((x) => x.drag !== null);
  // Expanded while the pointer is on it (the overlay is inside it), from a hover of its name
  // while that name is ellipsized: a name shown whole has nothing to expand.
  const [expanded, setExpanded] = useState(false);
  const wrap = ['irebase-chip-wrap', c ? '' : 'is-fixed', item.branch.length <= READABLE ? 'is-short' : '', c?.deleted ? 'is-deleted' : ''].filter(Boolean).join(' ');
  return (
    <HoverTooltip content={tip(noteOf(item))}>
      <span className={wrap} data-branch={item.branch} onContextMenu={chipMenu(tabId, item.branch)} onMouseLeave={() => setExpanded(false)}>
        <span
          className={['irebase-chip', kindClass(item), dragged ? 'is-dragged' : ''].filter(Boolean).join(' ')}
          style={laneStyle(item.color)}
          onMouseEnter={(e) => { if (!dragging && e.currentTarget.scrollWidth > e.currentTarget.clientWidth) setExpanded(true); }}
          onPointerDown={free ? (e) => startChipDrag(e, c.branch, (branch, row) => editState(tabId, (s) => moveChip(s, branch, row))) : undefined}
        >
          {item.branch}
        </span>
        {c && (c.locked ? <Lock size={11} aria-hidden="true" /> : (
          <button type="button" className="irebase-chip-x" aria-label={c.deleted ? `Keep ${c.branch}` : `Delete ${c.branch} when the rebase completes`} onClick={(e) => { e.stopPropagation(); editState(tabId, (s) => removeChip(s, c.branch)); }}>
            <X size={11} aria-hidden="true" />
          </button>
        ))}
        {expanded && <span className="irebase-chip-expand" aria-hidden="true"><FullChip tabId={tabId} item={item} /></span>}
      </span>
    </HoverTooltip>
  );
}

/** The hidden chips' menus, one submenu each (the "+N" pill's click and right-click). */
const hiddenMenu = (tabId: string, hidden: readonly ChipItem[]): MenuRow[] =>
  hidden.flatMap((it): MenuRow[] => {
    const rows = chipMenuRows(tabId, it.branch);
    return rows.length ? [{ kind: 'submenu', id: `irebase.chip.more.${it.branch}`, label: it.branch, icon: GitBranch, tooltip: noteOf(it), rows }] : [];
  });

/** "+N": the chips that don't fit. Its hover lists the row's chips at full names (each a chip:
 * drag, ×, menu); its click and right-click offer each hidden chip's menu. */
function MorePill({ tabId, items, hidden }: { tabId: string; items: readonly ChipItem[]; hidden: readonly ChipItem[] }) {
  const names = hidden.map((it) => it.branch).join(', ');
  return (
    <>
      <button
        type="button"
        className="irebase-chip-more"
        aria-label={`${hidden.length} more: ${names}`}
        onClick={(e) => { e.stopPropagation(); openMenuAt(e.currentTarget, hiddenMenu(tabId, hidden), undefined, () => hiddenMenu(tabId, hidden), `More branches: ${names}`); }}
        onContextMenu={(e) => openContextMenu(e, () => hiddenMenu(tabId, hidden))}
      >
        +{hidden.length}
      </button>
      <span className="irebase-chips-all" aria-hidden="true" onClick={(e) => e.stopPropagation()}>
        {items.map((it) => <FullChip key={it.branch} tabId={tabId} item={it} />)}
      </span>
    </>
  );
}

function AddBranch({ tabId, row }: { tabId: string; row: string }) {
  const [name, setName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (name === null) {
    return (
      <HoverTooltip content="Add a branch at this commit">
        <button type="button" className="irebase-chip-add" aria-label="Add a branch here" onClick={(e) => { e.stopPropagation(); setName(''); }}><Plus size={12} aria-hidden="true" /></button>
      </HoverTooltip>
    );
  }
  const submit = () => {
    const s = sessionOf(tabId);
    if (!s) return;
    const next = addChip(s.state, name, row);
    if (typeof next === 'string') return setError(next);
    editState(tabId, () => next);
    setName(null);
    setError(null);
  };
  return (
    <span className="irebase-chip-input" onClick={(e) => e.stopPropagation()}>
      <input
        aria-label="New branch name"
        value={name}
        autoFocus
        onChange={(e) => { setName(e.target.value); setError(null); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); submit(); }
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setName(null); setError(null); }
        }}
      />
      {error && <span role="status" className="irebase-chip-error">{error}</span>}
    </span>
  );
}

/** The chips git leaves on `row` (spec #3 §4.1): the rebased branch's on the effective top row
 * (fixed, Ruling 7), and every chip whose landing row this is. On the base's row (read-only):
 * the base's own chips, and any chip that lands there because every row below it is dropped;
 * no "+". The "+" sits outside the clipped list, so a row of long names never hides it. The
 * chips share the list's width, each at least a readable sliver of its name and its ×; the ones
 * that don't fit go behind a "+N" pill (UX2 E.2), so every chip stays reachable by mouse. */
export function ChipColumn({ tabId, row, state, g }: { tabId: string; row: string; state: EditorState; g: Grouping }) {
  const base = row === state.base.oid;
  const color = useChipColor(tabId);
  const items: ChipItem[] = [
    ...(base ? state.base.chips.map((b): ChipItem => ({ branch: b, kind: 'base', color: color(b) })) : []),
    ...(rebasedRow(state, g) === row ? [{ branch: state.branch, kind: 'rebased', color: color(state.branch) } satisfies ChipItem] : []),
    ...state.chips.filter((c) => chipRow(state, c.at, g) === row).map((c): ChipItem => ({ branch: c.branch, kind: 'chip', chip: c, color: c.origin === null ? undefined : color(c.branch) })),
  ];
  const shown = chipsShown(items, base ? BASE_LIST_W : LIST_W);
  return (
    <span className="irebase-chips" data-row={row}>
      <span className="irebase-chip-list">
        {items.slice(0, shown).map((it) => <Chip key={`${it.kind}:${it.branch}`} tabId={tabId} item={it} />)}
        {shown < items.length && <MorePill tabId={tabId} items={items} hidden={items.slice(shown)} />}
      </span>
      {!base && <AddBranch tabId={tabId} row={row} />}
    </span>
  );
}
