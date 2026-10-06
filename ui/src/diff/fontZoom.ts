import type { CSSProperties } from 'react';
import { useAppState } from '../app/state';
import { registerKeyHints } from '../shortcuts/hints';
import { registerKeys } from '../ui/keyRouter';
import { useToast } from '../ui/toast';
import { inFontZoomPanel, zoomDirection } from '../ui/zoom';
import { clampEditorFont, EDITOR_FONT_SIZE } from './options';

/**
 * The text size of a file's or a diff's body: Monaco's `editorFontSize` setting, which the
 * rendered Markdown in those panes follows too (`--md-font-size`, markdown.css). Over such a body
 * (`[data-font-zoom]`, `FONT_ZOOM_ATTR`), Ctrl+wheel and Ctrl+= / Ctrl+- / Ctrl+0 change it (1 px
 * a step, 8-32, 0 resets to 13) instead of the app zoom (ui/zoom.ts), which they keep everywhere
 * else. The new size shows in a toast and is saved like any setting.
 */

/** The size one step in `dir` from `px` (1 in, -1 out, 0 back to Monaco's 13). */
export function nextEditorFont(px: number, dir: 1 | -1 | 0): number {
  return dir === 0 ? EDITOR_FONT_SIZE : clampEditorFont(clampEditorFont(px) + dir);
}

/** The pane style that sizes its rendered Markdown like the editor. */
export const editorFontVar = (px: number) => ({ '--md-font-size': `${clampEditorFont(px)}px` }) as CSSProperties;

/** The editor font size, clamped: the rendered panes' text size (`MdFontPx`, their `--md-font-size`). */
export function useEditorFontPx(): number {
  return clampEditorFont(useAppState((s) => s.settings.editorFontSize));
}


/** A wheel's travel per step, in px: one mouse notch (100 px in Chromium) is one step; a
 * touchpad's (or a pinch's) small deltas add up to one. */
const WHEEL_STEP_PX = 50;
const LINE_PX = 40;

function step(dir: 1 | -1 | 0) {
  const { settings, setSettings } = useAppState.getState();
  const px = nextEditorFont(settings.editorFontSize, dir);
  if (px !== settings.editorFontSize) setSettings({ editorFontSize: px });
  useToast.getState().show(`Text size ${px} px`);
}

/** Installs the keys (the key router's app layer, beside the app zoom's) and Ctrl+wheel on
 * `window`. Returns the uninstaller. */
export function installFontZoom(): () => void {
  const offKeys = registerKeys('app', (e) => {
    const dir = zoomDirection(e);
    if (dir === null || !inFontZoomPanel(e.target)) return;
    e.preventDefault();
    step(dir);
    return 'handled';
  });
  let travel = 0;
  const onWheel = (e: WheelEvent) => {
    if (!e.ctrlKey || !inFontZoomPanel(e.target)) { travel = 0; return; }
    // Monaco (and the pane) never see it: no scroll, and no zoom of their own.
    e.preventDefault();
    e.stopPropagation();
    travel += e.deltaMode === 1 ? e.deltaY * LINE_PX : e.deltaY;
    if (Math.abs(travel) < WHEEL_STEP_PX) return;
    step(travel < 0 ? 1 : -1);
    travel = 0;
  };
  window.addEventListener('wheel', onWheel, { capture: true, passive: false });
  return () => {
    offKeys();
    window.removeEventListener('wheel', onWheel, { capture: true });
  };
}

// Shown in the Keyboard Shortcuts panel (Ctrl+/); metadata only.
registerKeyHints([
  { id: 'key.textSizeIn', section: 'Diff', label: 'Larger text (over a file or diff; also Ctrl+wheel)', keys: ['Ctrl+='], source: 'diff/fontZoom.ts' },
  { id: 'key.textSizeOut', section: 'Diff', label: 'Smaller text (over a file or diff)', keys: ['Ctrl+-'], source: 'diff/fontZoom.ts' },
  { id: 'key.textSizeReset', section: 'Diff', label: 'Reset the text size (over a file or diff)', keys: ['Ctrl+0'], source: 'diff/fontZoom.ts' },
]);
