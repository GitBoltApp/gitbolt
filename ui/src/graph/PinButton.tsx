import { GitBranch, Pin, PinOff, RotateCcw } from 'lucide-react';
import { useCallback, useMemo, useRef, useState } from 'react';
import type { ForkPayload } from '../api/gen/ForkPayload';
import type { PinSetting } from '../api/gen/PinSetting';
import type { SidebarPayload } from '../api/gen/SidebarPayload';
import { useRepoContext } from '../app/repoContext';
import { useRuntime } from '../app/runtime';
import { useAppState } from '../app/state';
import { HoverTooltip } from '../ui/HoverTooltip';
import { RefPicker, type PickItem } from '../ui/RefPicker';

const short = (ref: string) => ref.replace(/^refs\/(remotes|heads)\//, '');
const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' });
const AUTO = 'pin:auto';
const OFF = 'pin:off';
const NONE: readonly string[] = [];
/** The core's rule (`snapshot::default_pair`, `snapshot::pin_pair`). */
const DEFAULT_TIP = 'The local branch that tracks the main remote\'s default branch (its HEAD), pinned with that remote branch: both stay at the left. The remote branch alone if no local branch tracks it. The main remote is the one the others are forks of, else upstream, else origin. In a fork, the original project\'s default branch (upstream/main) with your local main, even when main tracks your fork: your fork\'s own main is never pinned. With no remote: main, master, dev or develop';

/** The Default's tooltip: the rule, then what makes this repo a fork (the core says how it knows). */
function defaultTip(fork: ForkPayload | undefined): string {
  if (!fork) return DEFAULT_TIP;
  const how = fork.detectedBy === 'forge' ? `the forge says ${fork.fork}'s project is a fork of ${fork.original}'s` : `${fork.original} is the original project by convention, ${fork.fork} your fork`;
  const pick = fork.trunk ? `${short(fork.trunk)} is pinned${fork.forkTrunk ? `, not ${short(fork.forkTrunk)}` : ''}` : `${fork.original} isn't fetched yet, so its default branch can't be pinned`;
  return `${DEFAULT_TIP}. This repository is a fork (${how}): ${pick}`;
}

/** A pinned pair's names, in the payload's order (the one leading lane 0 first): `main ↔ origin/main`,
 * `upstream/main ↔ main` in a fork, or the one name. */
const pairLabel = (refs: readonly string[]) => refs.map(short).join(' ↔ ');

/**
 * The refs pinning `ref` pins, as the core pairs them (`snapshot::pin_pair`): a local branch with
 * its upstream, a remote branch with the local branch tracking it (the one named like it, else
 * the first by name); else `ref` alone.
 */
function pinPair(ref: string, sidebar: SidebarPayload | null | undefined): string[] {
  const locals = sidebar?.locals ?? [];
  const local = locals.find((b) => b.fullName === ref);
  if (local) return local.upstream && !local.gone ? [ref, local.upstream] : [ref];
  const branch = sidebar?.remotes.flatMap((g) => g.branches).find((b) => b.fullName === ref)?.name;
  const tracking = locals.filter((b) => b.upstream === ref).sort((a, b) => Number(a.name !== branch) - Number(b.name !== branch) || byName(a.name, b.name));
  return tracking.length ? [tracking[0].fullName, ref] : [ref];
}

/**
 * The Graph header's pin button (spec §8.4): shows the current trunk, a pair when a local branch
 * pins with the remote branch it tracks (`main ↔ origin/main`). Its picker (amendment 4) offers
 * "Default" (detail: the pair it picked), "None" and every branch, so unpinning is always reversible.
 * Picking stores `RepoSettings.pin` and reloads the graph with it. Like the toolbar's branch
 * picker, the button toggles its own picker (K42) and the picker hangs below the button (K70).
 */
export function PinButton({ compact }: { compact: boolean }) {
  const { tabId, path } = useRepoContext();
  const pinned = useRuntime((s) => s.tabs[tabId]?.graph?.pinnedRefs ?? NONE);
  const sidebar = useRuntime((s) => s.tabs[tabId]?.sidebar);
  const fork = useRuntime((s) => s.tabs[tabId]?.graph?.fork);
  const setting = useAppState((s) => s.profile.repos[path]?.pin ?? null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const kind = setting?.kind ?? 'auto';
  const currentId = setting?.kind === 'ref' ? setting.name : kind === 'off' ? OFF : AUTO;

  const items = useMemo<PickItem[]>(() => {
    const tip = (ref: string) => {
      const pair = pinPair(ref, sidebar);
      return pair.length > 1 ? `Pin ${pairLabel(pair)}: both stay at the left` : `Pin ${short(ref)} as the trunk`;
    };
    const branches: PickItem[] = [
      ...(sidebar?.locals ?? []).map((b): PickItem => ({ id: b.fullName, label: b.name, icon: GitBranch, detail: 'local', tooltip: tip(b.fullName) })),
      ...(sidebar?.remotes ?? []).flatMap((g) => g.branches.map((b): PickItem => ({ id: b.fullName, label: `${g.name}/${b.name}`, icon: GitBranch, detail: 'remote', tooltip: tip(b.fullName) }))),
    ].sort((a, b) => byName(a.label, b.label));
    return [
      { id: AUTO, label: 'Default', icon: RotateCcw, detail: kind === 'auto' && pinned.length ? pairLabel(pinned) : undefined, tooltip: defaultTip(fork) },
      { id: OFF, label: 'None', icon: PinOff, tooltip: 'No trunk: every branch lays out freely' },
      ...branches,
    ].map((i) => ({ ...i, current: i.id === currentId }));
  }, [sidebar, kind, pinned, currentId, fork]);

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
  const label = kind === 'off' || !pinned.length ? 'No trunk' : pairLabel(pinned);
  const both = pinned.length > 1 ? `: both ${pinned.map(short).join(' and ')} stay at the left` : '';
  return (
    <>
      <HoverTooltip content={kind === 'off' ? 'No pinned trunk. Click to pin a branch to the left' : `Pinned trunk: ${label}${kind === 'auto' ? ' (default)' : ''}${both}. Click to change`}>
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
