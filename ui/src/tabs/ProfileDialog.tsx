import { useState } from 'react';
import { create } from 'zustand';
import { useModalKeys } from '../app/modalKeys';
import { useAppState } from '../app/state';

export const PROFILE_COLORS = ['#4d88ff', '#2ece9d', '#f2ca33', '#f25d2e', '#d90171', '#8e00c2', '#15a0bf', '#7bd938'];

export const useProfileDialog = create<{ mode: 'new' | 'rename' | null; open(mode: 'new' | 'rename'): void; close(): void }>((set) => ({
  mode: null,
  open: (mode) => set({ mode }),
  close: () => set({ mode: null }),
}));

/** New profile… / Rename profile… (the profile switcher's menu), spec §14.1. */
export function ProfileDialog() {
  const mode = useProfileDialog((s) => s.mode);
  if (!mode) return null;
  return <ProfileForm mode={mode} key={mode} />;
}

function ProfileForm({ mode }: { mode: 'new' | 'rename' }) {
  const current = useAppState((s) => s.profile);
  const [name, setName] = useState(mode === 'rename' ? current.name : '');
  const [color, setColor] = useState(mode === 'rename' ? current.color : PROFILE_COLORS[1]);
  const close = useProfileDialog((s) => s.close);
  // `ProfileForm` only mounts while the dialog is open (`ProfileDialog` above), so the trap is
  // simply always active for as long as this component exists; its cleanup (on Escape, Cancel,
  // Create/Save, or unmount) returns focus to the profile switcher button that opened it.
  const ref = useModalKeys<HTMLFormElement>(true, close);
  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (mode === 'new') await useAppState.getState().createProfile(trimmed, color);
    else useAppState.getState().renameProfile(trimmed, color);
    close();
  };
  return (
    <div className="modal-backdrop" onPointerDown={close}>
      <form
        ref={ref}
        className="modal"
        role="dialog"
        aria-label={mode === 'new' ? 'New profile' : 'Rename profile'}
        onPointerDown={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); void submit(); }}
      >
        <h2>{mode === 'new' ? 'New profile' : 'Rename profile'}</h2>
        <label>
          Name
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} aria-label="Profile name" />
        </label>
        <div className="swatches" role="radiogroup" aria-label="Color">
          {PROFILE_COLORS.map((c) => (
            <button key={c} type="button" role="radio" aria-checked={c === color} aria-label={c} className="swatch" style={{ background: c }} onClick={() => setColor(c)} />
          ))}
        </div>
        <div className="modal-actions">
          <button type="button" onClick={close}>Cancel</button>
          <button type="submit" disabled={!name.trim()}>{mode === 'new' ? 'Create' : 'Save'}</button>
        </div>
      </form>
    </div>
  );
}
