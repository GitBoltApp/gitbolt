import { ArrowDown, ArrowUp, Columns2, FileDown, FileUp, Rows2, SquareSplitVertical, Type } from 'lucide-react';
import { activeStore, registerActions, type Action } from '../app/actions';
import { splitConflicted } from '../details/conflicted';
import { displayedOrder } from '../files/fileListPrefs';
import type { DiffTarget, FileSection, PanelContent } from '../repo/store';
import { isTypingTarget } from '../ui/keys';
import { changeKeysOn } from './changeKeysOn';
import { useDiffPrefs, type DiffMode } from './diffPrefs';
import { isMarkdownTarget } from './markdownFiles';
import { clearMarkdownOverride, markdownViewOf } from './markdownOverride';

/**
 * The diff's keys as app actions, so the palette and the Keyboard Shortcuts panel have them:
 * the view mode (Ctrl+Shift+1 / 2 / 3, the toolbar's order), Source / Rendered (Ctrl+Shift+V, as
 * VS Code's Markdown preview), the change keys (F7 / Shift+F7, Shift+↑/↓: `useChangeKeys` takes
 * them) and the file keys (F8 / Shift+F8: the panel's files in their displayed order).
 */
const openDiff = () => activeStore()?.getState().diff ?? null;

/** Every file the right panel lists, in its displayed order: a WIP's Conflicted, Unstaged then
 * Staged (as ↑/↓ run through them), any other selection's sections in turn. */
export function panelTargets(panel: PanelContent): DiffTarget[] {
  const ready = (s: FileSection | undefined) => (s?.list.status === 'ready' ? s.list.data : null);
  const [first, second] = panel.sections;
  const unstaged = ready(first);
  const staged = ready(second);
  if (panel.selection.kind === 'wip' && unstaged && staged) {
    const s = splitConflicted(unstaged, staged);
    return [...displayedOrder(s.conflicted.files, first.spec), ...displayedOrder(s.unstaged.files, first.spec), ...displayedOrder(s.staged.files, second.spec)];
  }
  return panel.sections.flatMap((s) => { const l = ready(s); return l ? displayedOrder(l.files, s.spec) : []; });
}

/** Opens the panel's next (`1`) or previous file after the open one, wrapping; with none open,
 * the first or the last. The open file's view (File View, Diff View) carries over. */
function stepFile(dir: 1 | -1): void {
  const s = activeStore()?.getState();
  if (!s?.panel) return;
  const all = panelTargets(s.panel);
  if (!all.length) return;
  const at = s.diff ? all.findIndex((t) => t.key === s.diff!.key) : -1;
  const next = at < 0 ? all[dir === 1 ? 0 : all.length - 1] : all[(at + dir + all.length) % all.length];
  s.openFile({ ...next, view: s.diff?.view ?? next.view });
}

const MODES: Array<[DiffMode, string, typeof Rows2]> = [['hunk', 'Hunk', SquareSplitVertical], ['inline', 'Inline', Rows2], ['split', 'Split', Columns2]];

const actions: Action[] = [
  ...MODES.map(([mode, name, icon], i): Action => ({
    id: `diff.mode.${mode}`, label: `${name} diff view`, group: 'View', section: 'Diff', icon, tooltip: `Show the diff as ${name}`, shortcuts: [`Ctrl+Shift+${i + 1}`], menu: false,
    when: () => openDiff()?.view === 'diff',
    run: () => useDiffPrefs.getState().set({ mode }),
  })),
  {
    id: 'diff.toggleRendered', label: 'Toggle Source / Rendered', group: 'View', section: 'Diff', icon: Type, tooltip: 'Switch the open Markdown file between its source and its rendered view', shortcuts: ['Ctrl+Shift+V'], menu: false,
    when: () => { const d = openDiff(); return !!d && isMarkdownTarget(d); },
    // In a text box (or the editable working copy) it's Paste as plain text.
    yieldsTo: isTypingTarget,
    run: () => {
      const d = openDiff();
      if (!d) return;
      const next = markdownViewOf(d.path) === 'source' ? 'rendered' : 'source';
      clearMarkdownOverride();
      useDiffPrefs.getState().set({ markdownView: next });
    },
  },
  // `useChangeKeys` takes their keys (ahead of Monaco, synchronously); these are for the palette
  // and the panel.
  {
    id: 'diff.nextChange', label: 'Next change', group: 'View', section: 'Diff', icon: ArrowDown, tooltip: 'Go to the next change in the diff', shortcuts: ['F7', 'Shift+Down'], keysBy: 'diff/changeKeys.ts', menu: false,
    when: changeKeysOn,
    run: () => import('./DiffToolbar').then((m) => m.goToChange('next')),
  },
  {
    id: 'diff.prevChange', label: 'Previous change', group: 'View', section: 'Diff', icon: ArrowUp, tooltip: 'Go to the previous change in the diff', shortcuts: ['Shift+F7', 'Shift+Up'], keysBy: 'diff/changeKeys.ts', menu: false,
    when: changeKeysOn,
    run: () => import('./DiffToolbar').then((m) => m.goToChange('previous')),
  },
  {
    id: 'diff.nextFile', label: 'Next file', group: 'View', section: 'Diff', icon: FileDown, tooltip: 'Open the next file in the file list', shortcuts: ['F8'], menu: false,
    when: () => !!activeStore()?.getState().panel,
    run: () => stepFile(1),
  },
  {
    id: 'diff.prevFile', label: 'Previous file', group: 'View', section: 'Diff', icon: FileUp, tooltip: 'Open the previous file in the file list', shortcuts: ['Shift+F8'], menu: false,
    when: () => !!activeStore()?.getState().panel,
    run: () => stepFile(-1),
  },
];

const off = registerActions(actions);
import.meta.hot?.dispose(off);
