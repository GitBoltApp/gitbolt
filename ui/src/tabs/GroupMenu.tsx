import { Archive, Plus, Trash2, Ungroup } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Profile } from '../api/gen/Profile';
import type { TabGroup } from '../api/gen/TabGroup';
import { useAppState } from '../app/state';
import { deleteGroup, GROUP_COLORS, newTabInGroup, renameGroup, saveAndCloseGroup, setGroupColor, ungroup } from '../app/tabGroups';
import { guardTabClose } from '../diff/workingCopy';
import { confirmAction } from '../ui/ConfirmDialog';
import { OVERLAY_ATTR } from '../ui/arm/origin';
import { escapeDisarms } from '../ui/arm/store';
import { registerKeys } from '../ui/keyRouter';
import { chipEl, colorLabel, useGroupUi } from './groupUi';

const update = (fn: (p: Profile) => Profile) => useAppState.getState().updateProfile(fn);

/** Close the menu; Esc and Enter go back to the chip. */
function close(id: string, backToChip: boolean) {
  useGroupUi.getState().closeMenu();
  if (backToChip) chipEl(id)?.focus();
}

/**
 * The group menu (Firefox's), under the chip: the colour swatches, the name (applied as you
 * type), then New tab in group, Save and close group, Ungroup tabs, and Delete group, which closes
 * its tabs and arms in place first. Opened by a right-click or the menu key on the chip; Esc, Enter
 * in the name, or a press outside closes it.
 */
export function GroupMenu({ group }: { group: TabGroup }) {
  const id = group.id;
  const ref = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(group.name);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const r = chipEl(id)?.getBoundingClientRect();
    const w = ref.current?.offsetWidth ?? 0;
    if (r) setPos({ left: Math.max(4, Math.min(r.left, window.innerWidth - w - 4)), top: r.bottom + 2 });
  }, [id]);
  useEffect(() => { nameRef.current?.focus(); }, []);

  useEffect(() => {
    const offKeys = registerKeys('menu', (e) => {
      if (e.key !== 'Escape' || escapeDisarms(e)) return;
      e.preventDefault();
      close(id, true);
      return 'handled';
    });
    // A press outside closes it; one on the armed Delete's overlay is its confirm.
    const onPress = (e: PointerEvent) => {
      const t = e.target;
      if (t instanceof Element && (ref.current?.contains(t) || t.closest(`[${OVERLAY_ATTR}]`))) return;
      close(id, false);
    };
    window.addEventListener('pointerdown', onPress, true);
    return () => {
      offKeys();
      window.removeEventListener('pointerdown', onPress, true);
    };
  }, [id]);

  const n = group.tabs.length;
  const closing = (go: (p: Profile) => Profile) => guardTabClose(group.tabs, () => {
    update(go);
    useGroupUi.getState().closeMenu();
  });

  return createPortal(
    <div
      ref={ref}
      className="tg-menu"
      role="dialog"
      aria-label="Tab group"
      data-group-color={group.color}
      style={pos ? { left: pos.left, top: pos.top } : { visibility: 'hidden' }}
    >
      <input
        ref={nameRef}
        className="tg-name"
        aria-label="Group name"
        placeholder="Example: Backend"
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          update((p) => renameGroup(p, id, e.target.value));
        }}
        onKeyDown={(e) => { if (e.key === 'Enter') close(id, true); }}
      />
      <div className="tg-swatches" role="radiogroup" aria-label="Colour">
        {GROUP_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={group.color === c}
            aria-label={colorLabel(c)}
            className="tg-swatch"
            data-group-color={c}
            onClick={() => update((p) => setGroupColor(p, id, c))}
          />
        ))}
      </div>
      <div className="tg-menu-sep" role="separator" />
      <button type="button" className="tg-menu-row" onClick={() => {
        update((p) => newTabInGroup(p, id).profile);
        useGroupUi.getState().closeMenu();
      }}>
        <Plus size={14} aria-hidden /> New tab in group
      </button>
      <button type="button" className="tg-menu-row" onClick={() => closing((p) => saveAndCloseGroup(p, id))}>
        <Archive size={14} aria-hidden /> Save and close group
      </button>
      <button type="button" className="tg-menu-row" onClick={() => {
        update((p) => ungroup(p, id));
        useGroupUi.getState().closeMenu();
      }}>
        <Ungroup size={14} aria-hidden /> Ungroup tabs
      </button>
      <div className="tg-menu-sep" role="separator" />
      <button
        type="button"
        className="tg-menu-row danger"
        onClick={() => {
          void confirmAction({
            arm: `Click again to close ${n} tab${n === 1 ? '' : 's'}`, danger: true,
            title: 'Delete group?', body: `Closes the group's ${n} tab${n === 1 ? '' : 's'}.`, confirmLabel: 'Delete group',
          }).then((ok) => { if (ok) closing((p) => deleteGroup(p, id)); });
        }}
      >
        <Trash2 size={14} aria-hidden /> Delete group
      </button>
    </div>,
    document.body,
  );
}
