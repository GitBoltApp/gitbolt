import { Plus, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { ForgeUser } from '../../api/gen/ForgeUser';
import { ForgeAvatar } from '../../avatars/Avatar';
import { isDismissKey } from '../../ui/HoverTooltip';
import { useKeys } from '../../ui/keyRouter';
import { chipStyle } from '../chipStyle';
import { SearchPicker, type PickOption } from '../create/SearchPicker';
import { EmojiText } from '../emoji';
import './forgeUi.css';

/** A person (avatar chip) or a label (a pill in the forge's colour). */
export type PeopleChip = { key: string; label: string; user: ForgeUser } | { key: string; label: string; color: string | null };

/** Editable mode: + Add opens the search; each option's value is what picking it does. */
export interface RowEdit {
  search(query: string): Promise<Array<PickOption<() => void>>>;
  peek?(query: string): { options: Array<PickOption<() => void>>; stale: boolean } | undefined;
  onRemove(key: string): void;
  /** After + Add (Assignees' "Assign to me"). */
  extra?: ReactNode;
}

export interface PeopleRow {
  /** "Reviewers", "Assignees", "Labels": the row's caption and the search box's name. */
  label: string;
  /** "reviewer": + Add's name is "Add reviewer". */
  noun: string;
  /** null: not loaded yet. */
  chips: PeopleChip[] | null;
  edit?: RowEdit;
}

/**
 * Reviewers, Assignees and Labels in one card (the Create flyout, Edit, the MR/PR view): avatar
 * chips and colour pills. Editable rows have × on each chip and a dashed + Add that opens the
 * search in a popover; read-only rows show the chips alone, or a dim "None".
 */
export function PeopleCard({ rows, disabled = false, label = 'People and labels' }: { rows: PeopleRow[]; disabled?: boolean; label?: string }) {
  return (
    <div className="people" role="group" aria-label={label}>
      {rows.map((r) => (
        <div key={r.label} className="people-row">
          <span className="people-k">{r.label}</span>
          <div className="people-chips">
            {r.chips === null && <span className="people-none">Loading…</span>}
            {r.chips?.length === 0 && !r.edit && <span className="people-none">None</span>}
            {r.chips?.map((c) => <Chip key={c.key} chip={c} onRemove={r.edit ? () => r.edit!.onRemove(c.key) : undefined} disabled={disabled} />)}
            {r.edit && <AddButton row={r} disabled={disabled} />}
            {r.edit?.extra}
          </div>
        </div>
      ))}
    </div>
  );
}

function Chip({ chip, onRemove, disabled }: { chip: PeopleChip; onRemove?: () => void; disabled: boolean }) {
  const rm = onRemove && (
    <button type="button" className="people-rm" aria-label={`Remove ${chip.label}`} disabled={disabled} onClick={onRemove}><X size={11} aria-hidden /></button>
  );
  if ('user' in chip) {
    return <span className="people-chip"><ForgeAvatar user={chip.user} size={18} /><span className="people-name">{chip.label}</span>{rm}</span>;
  }
  return (
    <span className="people-pill" data-colored={chip.color ? '' : undefined} style={chipStyle(chip.color)}>
      <EmojiText text={chip.label} />{rm}
    </span>
  );
}

const POP_W = 280;
/** The popover's tallest: the search box and its list (forgeUi.css caps the list at 220px). */
const POP_H = 280;

function AddButton({ row, disabled }: { row: PeopleRow; disabled: boolean }) {
  const [at, setAt] = useState<DOMRect | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const close = (refocus: boolean) => {
    setAt(null);
    if (refocus) btn.current?.focus({ preventScroll: true });
  };
  useEffect(() => { if (disabled) setAt(null); }, [disabled]);
  // Esc closes the search, and nothing behind it (the flyout stays open).
  useKeys('menu', (e) => {
    if (!isDismissKey(e)) return;
    e.preventDefault();
    close(true);
    return 'handled';
  }, at !== null);
  useLayoutEffect(() => {
    if (!at) return;
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!pop.current?.contains(t) && !btn.current?.contains(t)) close(false);
    };
    // It's placed in the window: a scroll that moves + Add (the flyout's body) closes it. Not a
    // scroll event that only lands now, from a scroll before the click (scroll events come a frame late).
    const scroll = (e: Event) => {
      if (pop.current?.contains(e.target as Node)) return;
      const r = btn.current?.getBoundingClientRect();
      if (!r || Math.abs(r.top - at.top) > 1 || Math.abs(r.left - at.left) > 1) close(false);
    };
    const resize = () => close(false);
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', resize);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', resize);
    };
  }, [at]);
  const edit = row.edit!;
  // Under the button; over it (growing upwards) when the window has more room there.
  const place = (r: DOMRect) => {
    const left = Math.max(4, Math.min(r.left, window.innerWidth - POP_W - 4));
    const below = window.innerHeight - r.bottom;
    return below < POP_H && r.top > below ? { left, bottom: window.innerHeight - r.top + 4 } : { left, top: r.bottom + 4 };
  };
  return (
    <>
      <button
        ref={btn}
        type="button"
        className="people-add"
        aria-label={`Add ${row.noun}`}
        aria-haspopup="listbox"
        aria-expanded={at !== null}
        disabled={disabled}
        onClick={(e) => setAt(at ? null : e.currentTarget.getBoundingClientRect())}
      >
        <Plus size={12} aria-hidden /> Add
      </button>
      {at && (
        <div
          ref={pop}
          className="people-pop"
          style={{ ...place(at), width: POP_W }}
          // Tab out of the search closes it.
          onBlur={(e) => { if (e.relatedTarget instanceof Node && !e.currentTarget.contains(e.relatedTarget)) close(false); }}
        >
          <SearchPicker<() => void> popover label={row.label} chips={row.chips ?? []} onRemove={() => {}} search={edit.search} peek={edit.peek} onPick={(run) => run()} />
        </div>
      )}
    </>
  );
}
