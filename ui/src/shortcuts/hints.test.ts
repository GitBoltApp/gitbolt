import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..');
const HANDLER = /registerKeys\(|useKeys\(|onKeyDown[=:]|addEventListener\('keydown'/;

/** Files with a key handler that are not user shortcuts (the router itself, drag cancel, text
 * inputs' own Enter/Esc, resize handles, tooltips, the arm layer). Add to it with a reason. */
const EXEMPT: Record<string, string> = {
  'markdown/MdLink.tsx': 'a link’s Enter, as a native link’s',
  'ui/keyRouter.ts': 'the dispatcher',
  'ui/arm/store.ts': 'Esc disarms an armed control (confirm model)',
  'ui/arm/ArmLayer.tsx': 'Esc / click-out disarm',
  'ui/arm/origin.ts': 'arm origin focus',
  'ui/HoverTooltip.tsx': 'Esc dismisses a tooltip',
  'ui/TooltipHost.tsx': 'Esc dismisses a tooltip',
  'ui/Toast.tsx': 'toast dismissal',
  'ui/Select.tsx': 'dropdown arrows / Esc',
  'ui/RefPicker.tsx': 'picker arrows / Enter / Esc',
  'forge/create/SearchPicker.tsx': 'picker arrows / Enter / Backspace',
  'ui/Switch.tsx': 'a switch toggles on Space / Enter, as a native control',
  'forge/ui/PeopleCard.tsx': '+ Add search: Esc closes it',
  'forge/HostCombobox.tsx': 'combobox arrows / Enter / Esc',
  'ui/resetHandle.ts': 'resize handle Enter',
  'graph/ColumnResizer.tsx': 'resize handle arrows',
  'repo/PanelResizer.tsx': 'resize handle arrows',
  'sidebar/PanelDivider.tsx': 'resize handle arrows',
  'details/SplitResizer.tsx': 'resize handle arrows',
  'ui/flyout/FlyoutHost.tsx': 'resize handle arrows',
  'tabs/useTabDrag.ts': 'drag cancel (Esc)',
  'irebase/rowDrag.ts': 'drag cancel (Esc)',
  'irebase/chipDrag.ts': 'drag cancel (Esc)',
  'irebase/ChipColumn.tsx': 'chip focus keys inside the rebase editor',
  'auth/AuthModal.tsx': 'dialog keys (Esc / Enter / Tab)',
  'settings/SettingsView.tsx': 'settings form keys',
  'toolbar/DefaultPicker.tsx': 'dropdown keys',
  'openIn/OpenInMenu.tsx': 'menu keys',
  'tags/TagNameInput.tsx': 'input Enter / Esc',
  'branches/BranchNameInput.tsx': 'input Enter / Esc',
  'errors/PanelErrorBoundary.tsx': 'error panel Esc',
  'diff/monaco/host.ts': 'Monaco-owned keys',
  'diff/monaco/hexPanes.ts': 'hex pane keys',
  'app/shortcuts.ts': 'the Ctrl-chord dispatcher (its actions are listed by the panel)',
  'nav/input.ts': 'Alt+←/→ dispatch (its actions, Go back / Go forward, are listed by the panel)',
  'shortcuts/ShortcutsPanel.tsx': 'this panel',
};

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(n) && !/\.test\.|\.d\.ts$/.test(n)) out.push(p);
  }
  return out;
}

/** Every `source: '…'` in a hint declaration, across ui/src. */
function declaredSources(): string[] {
  return walk(SRC).flatMap((f) => (readFileSync(f, 'utf8').includes('registerKeyHints(') ? [...readFileSync(f, 'utf8').matchAll(/source: '([^']+)'|, '([\w/.]+\.tsx?)'(?:, '[^']*')?\),?$/gm)].map((m) => m[1] ?? m[2]) : []));
}

describe('key hints', () => {
  it('every file with a key handler has a hint or is exempt', () => {
    // Static, so a hint in a lazily loaded module counts without importing it.
    const covered = new Set(declaredSources());
    const missing = walk(SRC)
      .filter((f) => HANDLER.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC, f))
      .filter((f) => !covered.has(f) && !(f in EXEMPT));
    expect(missing, 'add a registerKeyHints entry with this source, or exempt it in hints.test.ts').toEqual([]);
  });

  it('hint sources exist', () => {
    for (const src of declaredSources()) expect(() => statSync(join(SRC, src)), src).not.toThrow();
  });
});
