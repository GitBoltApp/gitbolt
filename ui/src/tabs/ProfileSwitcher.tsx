import { Check, Pencil, Plus, Trash2, User } from 'lucide-react';
import { useAppState } from '../app/state';
import { openMenuAt } from '../menu/menuStore';
import type { MenuRow } from '../menu/types';
import { HoverTooltip } from '../ui/HoverTooltip';
import { ProfileDialog, useProfileDialog } from './ProfileDialog';

function rows(): MenuRow[] {
  const { profiles, profile, switchProfile, deleteProfile } = useAppState.getState();
  const others = profiles.filter((p) => p.id !== profile.id);
  return [
    ...profiles.map((p): MenuRow => ({
      kind: 'action',
      id: `profile.${p.id}`,
      label: p.name,
      icon: p.id === profile.id ? Check : User,
      tooltip: p.id === profile.id ? 'The current profile' : `Switch to ${p.name}: its tabs replace these (amendment 5)`,
      run: () => { void switchProfile(p.id); },
    })),
    { kind: 'separator' },
    { kind: 'action', id: 'profile.new', label: 'New profile…', icon: Plus, tooltip: 'Create a profile with its own tabs, recent repos and settings', run: () => useProfileDialog.getState().open('new') },
    { kind: 'action', id: 'profile.rename', label: 'Rename profile…', icon: Pencil, tooltip: 'Change this profile\'s name and color', run: () => useProfileDialog.getState().open('rename') },
    ...(others.length
      ? [{
          kind: 'submenu' as const, id: 'profile.delete', label: 'Delete profile', icon: Trash2, tooltip: 'Delete another profile (switch away before deleting the current one)',
          rows: others.map((p): MenuRow => ({ kind: 'action', id: `profile.delete.${p.id}`, label: p.name, icon: Trash2, tooltip: `Delete ${p.name} and its tabs`, run: () => { void deleteProfile(p.id); } })),
        }]
      : []),
  ];
}

/** Far right of the tab bar (spec §6.2), and its New/Rename/Delete dialog. */
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
