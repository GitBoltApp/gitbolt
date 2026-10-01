import type { ReactNode } from 'react';
import { HoverTooltip } from '../ui/HoverTooltip';
import { SETTINGS } from './schema';

/** A setting's row: its label (instant tooltip with the explanation) and its control. `group`: the
 * control is several elements (or the app's own Select), labelled by `label-<id>` rather than a
 * `<label for>`. Shared by SettingsView and the sections other modules own (theme/AppearanceSection). */
export function Row({ id, children, group = false }: { id: string; children: ReactNode; group?: boolean }) {
  const def = SETTINGS.find((s) => s.id === id)!;
  const label = group
    ? <span className="setting-label" id={`label-${id}`}>{def.label}</span>
    : <label className="setting-label" htmlFor={`input-${id}`}>{def.label}</label>;
  return (
    <div className="setting-row" data-setting-id={id} id={`setting-${id}`}>
      {def.help ? <HoverTooltip content={def.help}>{label}</HoverTooltip> : label}
      <div className="setting-control">{children}</div>
    </div>
  );
}
