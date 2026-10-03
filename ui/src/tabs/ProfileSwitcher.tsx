import { forwardRef } from 'react';
import { Pencil, Plus, Trash2, type LucideIcon, type LucideProps } from 'lucide-react';
import { useAppState } from '../app/state';
import { openMenuAt } from '../menu/menuStore';
import type { MenuRow } from '../menu/types';
import { confirmAction } from '../ui/ConfirmDialog';
import { HoverTooltip } from '../ui/HoverTooltip';
import { ProfileDialog, useProfileDialog } from './ProfileDialog';

/**
 * K69: each profile's row shows its colour, as a dot the size of a menu icon; the current one's
 * dot has a ring (in place of the old check). One component per colour/state, kept, so the menu's
 * memoized rows don't remount their icon.
 */
const dotIcons = new Map<string, LucideIcon>();
export function profileDotIcon(color: string, current: boolean): LucideIcon {
  const key = `${color}|${current}`;
  let icon = dotIcons.get(key);
  if (!icon) {
    const Dot = forwardRef<SVGSVGElement, LucideProps>(({ size = 16, className }, ref) => (
      <svg ref={ref} width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden data-profile-dot={color}>
        <circle cx="12" cy="12" r={current ? 6 : 7} fill={color} />
        {current && <circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" strokeWidth="2" />}
      </svg>
    ));
    Dot.displayName = `ProfileDot(${key})`;
    icon = Dot as unknown as LucideIcon;
    dotIcons.set(key, icon);
  }
  return icon;
}

function rows(): MenuRow[] {
  const { profiles, profile, switchProfile, deleteProfile } = useAppState.getState();
  const others = profiles.filter((p) => p.id !== profile.id);
  return [
    ...profiles.map((p): MenuRow => ({
      kind: 'action',
      id: `profile.${p.id}`,
      label: p.name,
      icon: profileDotIcon(p.color, p.id === profile.id),
      tooltip: p.id === profile.id ? 'The current profile' : `Switch to ${p.name}: its tabs replace these (amendment 5)`,
      run: () => { void switchProfile(p.id); },
    })),
    { kind: 'separator' },
    { kind: 'action', id: 'profile.new', label: 'New profile…', icon: Plus, tooltip: 'Create a profile with its own tabs, recent repos and settings', run: () => useProfileDialog.getState().open('new') },
    { kind: 'action', id: 'profile.rename', label: 'Edit profile…', icon: Pencil, tooltip: 'Change this profile\'s name and color', run: () => useProfileDialog.getState().open('rename') },
    ...(others.length
      ? [{
          kind: 'submenu' as const, id: 'profile.delete', label: 'Delete profile', icon: Trash2, tooltip: 'Delete another profile (switch away before deleting the current one)',
          rows: others.map((p): MenuRow => ({
            kind: 'action', id: `profile.delete.${p.id}`, label: `${p.name}…`, icon: Trash2, tooltip: `Delete ${p.name} and its tabs`,
            // K68: never in one click — the profile, its tabs and its recent list go.
            run: () => {
              void confirmAction({
                title: `Delete the profile “${p.name}”?`,
                body: 'Its tabs, recent repositories and settings are removed. Your repositories on disk are not touched. This cannot be undone.',
                confirmLabel: 'Delete profile',
                arm: `Click again to delete ${p.name} and its tabs`,
                danger: true,
              }).then((ok) => { if (ok) void deleteProfile(p.id); });
            },
          })),
        }]
      : []),
  ];
}

/** Far right of the tab bar (spec §6.2), and its New/Edit/Delete dialog. */
export function ProfileSwitcher() {
  const name = useAppState((s) => s.profile.name);
  const color = useAppState((s) => s.profile.color);
  return (
    <>
      <HoverTooltip content="Switch profile">
        <button type="button" className="profile-switcher" aria-label={`Profile: ${name}`} onClick={(e) => openMenuAt(e.currentTarget, rows(), undefined, rows, 'Switch profile')}>
          <span className="profile-dot" style={{ background: color }} aria-hidden />
          {name}
        </button>
      </HoverTooltip>
      <ProfileDialog />
    </>
  );
}
