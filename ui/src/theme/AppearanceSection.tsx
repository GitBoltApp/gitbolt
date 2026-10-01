import { useEffect, useState } from 'react';
import { useAppState } from '../app/state';
import { Row } from '../settings/Row';
import { Select } from '../ui/Select';
import { isWindowBlur, refocusWhenWindowReturns } from '../ui/windowBlur';
import { isHexColor, resolveColors } from './apply';
import type { GraphOverrides } from './store';
import { DEFAULT_THEME_ID, isThemeId, THEME_IDS, THEMES, type ThemeId } from './themes';
import './appearance.css';

const THEME_CHOICES = THEME_IDS.map((id) => [id, THEMES[id].label] as const);
const LANES = THEMES[DEFAULT_THEME_ID].graph.length;

/** A lane's colour box: applies on Enter or blur (`#` optional, any case, `#rgb` shorthand
 * expanded), clearing it goes back to the theme's colour, and anything else snaps back. */
function LaneField({ index, value, own, onCommit }: { index: number; value: string; own: string; onCommit(v: string | null): void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const typed = draft.trim().toLowerCase().replace(/^#/, '');
  const hex = `#${/^[0-9a-f]{3}$/.test(typed) ? typed.replace(/./g, '$&$&') : typed}`;
  const commit = () => {
    if (typed === '') {
      setDraft(value);
      return onCommit(null);
    }
    if (!isHexColor(hex)) return setDraft(value);
    setDraft(hex);
    if (hex !== value) onCommit(hex === own ? null : hex);
  };
  return (
    <form className="inline-form" noValidate onSubmit={(e) => { e.preventDefault(); commit(); }}>
      <span className="lane-color">
        <span className="lane-swatch" aria-hidden style={{ background: isHexColor(hex) ? hex : value }} />
        <input
          id={`input-graphColors-${index}`}
          className="lane-hex"
          aria-label={`Lane ${index + 1} color`}
          spellCheck={false}
          maxLength={7}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => { if (isWindowBlur()) return refocusWhenWindowReturns(e.currentTarget); commit(); }}
        />
      </span>
    </form>
  );
}

/** Settings → Appearance: the theme (the app's own dropdown, never a native `<select>`, K92) and
 * the current theme's lane colour overrides. Both save to AppSettings; `bind.ts` applies them. */
export function AppearanceSection() {
  const theme = useAppState((s) => s.settings.theme);
  const saved = useAppState((s) => s.settings.graphColorOverrides);
  const setSettings = useAppState((s) => s.setSettings);
  const id: ThemeId = isThemeId(theme) ? theme : DEFAULT_THEME_ID;
  const overrides = (saved ?? {}) as GraphOverrides;
  const own = THEMES[id].graph;
  const lanes = resolveColors(THEMES[id], overrides[id]).graph;

  const setLane = (i: number, v: string | null) => {
    const base = overrides[id] ?? [];
    const next = Array.from({ length: LANES }, (_, k) => (k === i ? v : isHexColor(base[k]) ? base[k] : null));
    const rest = { ...overrides };
    if (next.some((c) => c !== null)) rest[id] = next;
    else delete rest[id];
    setSettings({ graphColorOverrides: rest });
  };
  const resetLanes = () => {
    const rest = { ...overrides };
    delete rest[id];
    setSettings({ graphColorOverrides: rest });
  };

  return (
    <>
      <Row id="theme" group>
        <Select<ThemeId> id="input-theme" aria-labelledby="label-theme" value={id} onChange={(v) => setSettings({ theme: v })} options={THEME_CHOICES} />
      </Row>
      <Row id="graphColors" group>
        <div className="lane-colors" role="group" aria-labelledby="label-graphColors">
          {lanes.map((c, i) => <LaneField key={i} index={i} value={c} own={own[i]} onCommit={(v) => setLane(i, v)} />)}
        </div>
        <button type="button" disabled={!overrides[id]} onClick={resetLanes}>Reset lane colors</button>
      </Row>
    </>
  );
}
