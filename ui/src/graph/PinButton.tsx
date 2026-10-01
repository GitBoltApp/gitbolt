import { GitBranch, Pin, PinOff, RotateCcw } from 'lucide-react';
import { useCallback, useMemo, useRef, useState } from 'react';
import type { PinSetting } from '../api/gen/PinSetting';
import { useRepoContext } from '../app/repoContext';
import { useRuntime } from '../app/runtime';
import { useAppState } from '../app/state';
import { HoverTooltip } from '../ui/HoverTooltip';
import { RefPicker, type PickItem } from '../ui/RefPicker';

const short = (ref: string) => ref.replace(/^refs\/(remotes|heads)\//, '');
const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' });
const AUTO = 'pin:auto';
const OFF = 'pin:off';

/**
 * The Graph header's pin button (spec §8.4): shows the current trunk. Its picker (amendment 4)
 * offers "Default (origin/HEAD)", "None" and every branch, so unpinning is always reversible.
 * Picking stores `RepoSettings.pin` and reloads the graph with it. Like the toolbar's branch
 * picker, the button toggles its own picker (K42) and the picker hangs below the button (K70).
 */
export function PinButton({ compact }: { compact: boolean }) {
  const { tabId, path } = useRepoContext();
  const pinned = useRuntime((s) => s.tabs[tabId]?.graph?.pinnedRef ?? null);
  const sidebar = useRuntime((s) => s.tabs[tabId]?.sidebar);
  const setting = useAppState((s) => s.profile.repos[path]?.pin ?? null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const kind = setting?.kind ?? 'auto';
  const currentId = setting?.kind === 'ref' ? setting.name : kind === 'off' ? OFF : AUTO;

  const items = useMemo<PickItem[]>(() => {
    const branches: PickItem[] = [
      ...(sidebar?.locals ?? []).map((b): PickItem => ({ id: b.fullName, label: b.name, icon: GitBranch, detail: 'local', tooltip: `Pin ${b.name} as the trunk` })),
      ...(sidebar?.remotes ?? []).flatMap((g) => g.branches.map((b): PickItem => ({ id: b.fullName, label: `${g.name}/${b.name}`, icon: GitBranch, detail: 'remote', tooltip: `Pin ${g.name}/${b.name} as the trunk` }))),
    ].sort((a, b) => byName(a.label, b.label));
    return [
      { id: AUTO, label: 'Default (origin/HEAD)', icon: RotateCcw, detail: kind === 'auto' && pinned ? short(pinned) : undefined, tooltip: 'Use the repository\'s default branch as the trunk (origin/HEAD, else main, master, dev or develop)' },
      { id: OFF, label: 'None', icon: PinOff, tooltip: 'No trunk: every branch lays out freely' },
      ...branches,
    ].map((i) => ({ ...i, current: i.id === currentId }));
  }, [sidebar, kind, pinned, currentId]);

  const close = useCallback(() => {
    setAnchor(null);
    button.current?.focus({ preventScroll: true });
  }, []);
  if (!tabId || !path) return null;
  const choose = (pin: PinSetting) => {
    setAnchor(null);
    useAppState.getState().updateRepo(path, (r) => ({ ...r, pin }));
    void useRuntime.getState().refresh(tabId);
  };
  const label = kind === 'off' || !pinned ? 'No trunk' : short(pinned);
  return (
    <>
      <HoverTooltip content={kind === 'off' ? 'No pinned trunk. Click to pin a branch to the left' : `Pinned trunk: ${label}${kind === 'auto' ? ' (default)' : ''}. Click to change`}>
        <button
          ref={button}
          type="button"
          className="pin-btn"
          aria-label={`Pinned trunk: ${label}`}
          aria-haspopup="listbox"
          aria-expanded={!!anchor}
          onClick={(e) => setAnchor(anchor ? null : e.currentTarget.getBoundingClientRect())}
        >
          <Pin size={12} aria-hidden />
          {!compact && <span className="pin-name">{label}</span>}
        </button>
      </HoverTooltip>
      {anchor && (
        <RefPicker
          anchor={anchor}
          ignore={button.current}
          items={items}
          placeholder="Pin a branch as trunk"
          onClose={close}
          onPick={(item) => {
            if (item.id === AUTO) choose({ kind: 'auto' });
            else if (item.id === OFF) choose({ kind: 'off' });
            else choose({ kind: 'ref', name: item.id });
          }}
        />
      )}
    </>
  );
}
