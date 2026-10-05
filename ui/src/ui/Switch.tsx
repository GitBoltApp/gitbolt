import { useId, type KeyboardEvent, type ReactNode } from 'react';
import './switch.css';

export interface SwitchProps {
  checked: boolean;
  onChange(next: boolean): void;
  /** Its accessible name. */
  label: string;
  /** One line under the label (its accessible description). */
  description?: ReactNode;
  disabled?: boolean;
}

/**
 * An on/off toggle: a `role="switch"` button with `aria-checked`. Space and Enter toggle it, as
 * does a click on it or on its label. Lay several out in a `.switch-group` (side by side, one
 * column when narrow).
 */
export function Switch({ checked, onChange, label, description, disabled = false }: SwitchProps) {
  const uid = useId();
  const keys = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== ' ' && e.key !== 'Enter') return;
    // Taken here, not left to the button's own activation (Space clicks on key up): one toggle per press.
    e.preventDefault();
    e.stopPropagation();
    if (!e.repeat && !disabled) onChange(!checked);
  };
  return (
    // A click on the text clicks the button (a label activates its control).
    <label className="switch-row" data-disabled={disabled || undefined}>
      <button
        type="button"
        role="switch"
        className="switch"
        aria-checked={checked}
        aria-labelledby={`${uid}-l`}
        aria-describedby={description ? `${uid}-d` : undefined}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        onKeyDown={keys}
        onKeyUp={(e) => { if (e.key === ' ') e.preventDefault(); }}
      >
        <span className="switch-knob" aria-hidden />
      </button>
      <span className="switch-text">
        <span id={`${uid}-l`} className="switch-label">{label}</span>
        {description && <span id={`${uid}-d`} className="switch-desc">{description}</span>}
      </span>
    </label>
  );
}
