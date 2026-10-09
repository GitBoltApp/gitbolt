import { beforeAll, describe, expect, it } from 'vitest';
import type { Action } from './actions';

/**
 * The whole registry, as the app registers it (`features.ts`): the Keyboard Shortcuts panel and
 * the palette are built from it, so these are their checks too.
 */
let all: Action[] = [];
let hints: Array<{ id: string; keys: string[]; context?: string }> = [];
beforeAll(async () => {
  await import('./features');
  await import('../shortcuts/viewHints');
  all = (await import('./actions')).allActions();
  hints = (await import('../shortcuts/hints')).keyHints();
}, 60000);

/** Combos two actions share on purpose: their `when`s never hold at once (the open file is either
 * closed or the tab is; it's staged or unstaged), so one key press is one action. */
const EXCLUSIVE: Record<string, string[]> = {
  'Ctrl+W': ['file.closeFile', 'file.closeTab'],
  'Ctrl+Shift+S': ['stage.file', 'stage.unstageFile'],
};

/** Keys the app must not take: the desktop's (GNOME, IBus), Chromium's own that would still act
 * (devtools, reload, quit) or that people expect from the browser shell. */
const RESERVED = [
  'Ctrl+Shift+U', 'Ctrl+Shift+E', 'Ctrl+.', 'Ctrl+;', // IBus: Unicode and emoji input
  'Ctrl+Alt+T', 'Ctrl+Alt+Delete', 'Ctrl+Alt+Backspace', 'Ctrl+Alt+Left', 'Ctrl+Alt+Right', 'Ctrl+Alt+Up', 'Ctrl+Alt+Down', 'Ctrl+Alt+L', 'Ctrl+Alt+D', 'Ctrl+Alt+Tab', // GNOME / Ubuntu
  'Alt+F1', 'Alt+F2', 'Alt+F4', 'Alt+F7', 'Alt+F8', 'Alt+F10', 'Alt+Tab', // GNOME window keys
  'Ctrl+Shift+I', 'Ctrl+Shift+J', 'Ctrl+Shift+C', 'F12', 'Ctrl+R', 'Ctrl+Shift+R', 'F5', 'Ctrl+Shift+Q', 'Ctrl+Shift+W', 'F11', // Chromium
  'Ctrl+Space', 'Ctrl+Shift+Space', // input method switching
];

/** Key hints the app's actions may share: they're bound to a focused field or view of their own
 * (the commit message, the rebase editor, the MR/PR forms), which the action yields to. */
const SHARED_WITH_HINTS = new Set(['Ctrl+Enter', 'Ctrl+Z', 'Ctrl+Shift+Z', 'F7', 'Shift+F7', 'Shift+Up', 'Shift+Down']);

const label = (a: Action) => a.label;
const bound = () => all.flatMap((a) => (a.keysBy ? [] : (a.shortcuts ?? []).map((k) => ({ k, a }))));

describe('the action registry', () => {
  it('every action has a label and a tooltip', () => {
    for (const a of all) {
      expect(label(a).trim(), a.id).not.toBe('');
      expect(a.tooltip.trim(), a.id).not.toBe('');
    }
  });

  it('no key runs two actions, except exclusive pairs', () => {
    const by = new Map<string, string[]>();
    for (const { k, a } of bound()) by.set(k, [...(by.get(k) ?? []), a.id]);
    const shared = [...by].filter(([, ids]) => ids.length > 1);
    expect(Object.fromEntries(shared)).toEqual(EXCLUSIVE);
  });

  it('no action takes a desktop, input-method or browser key', () => {
    expect(bound().filter(({ k }) => RESERVED.includes(k)).map(({ k, a }) => `${k} ${a.id}`)).toEqual([]);
  });

  it("no action's key is a view's key hint too, except the ones it yields to", () => {
    const keys = new Set(bound().map(({ k }) => k));
    const clash = hints.flatMap((h) => h.keys.filter((k) => keys.has(k) && !SHARED_WITH_HINTS.has(k)).map((k) => `${k} ${h.id}`));
    // Zoom and text size: the same keys by design, over a file or diff or elsewhere (ui/zoom.ts).
    expect(clash.filter((c) => !/^Ctrl\+[=0-]/.test(c))).toEqual([]);
  });

  it('binds the keyboard pass key map', () => {
    const map = Object.fromEntries(bound().map(({ k, a }) => [`${k} ${a.id}`, true]));
    const want = [
      'Ctrl+Shift+S stage.file', 'Ctrl+Shift+S stage.unstageFile', 'Ctrl+Shift+D stage.hunk', 'Ctrl+Enter commit.commit',
      'Ctrl+L repo.fetch', 'Ctrl+Shift+L sync.pull', 'Ctrl+Shift+K sync.push', 'Ctrl+Shift+N branch.create', 'Ctrl+Alt+S stash.push', 'Ctrl+Alt+P stash.pop',
      'Ctrl+Shift+1 diff.mode.hunk', 'Ctrl+Shift+2 diff.mode.inline', 'Ctrl+Shift+3 diff.mode.split', 'Ctrl+Shift+V diff.toggleRendered',
      'F8 diff.nextFile', 'Shift+F8 diff.prevFile', 'Ctrl+Shift+H history.file', 'Ctrl+Shift+B history.blame',
      'Alt+1 view.focusSidebar', 'Alt+2 view.focusGraph', 'Alt+3 view.focusFiles', 'Alt+4 view.focusDiff',
      'Ctrl+1 view.tab1', 'Ctrl+8 view.tab8', 'Ctrl+9 view.lastTab', 'Ctrl+W file.closeFile',
      'Ctrl+Shift+A mr.approve', 'Ctrl+Shift+M mr.merge', 'Ctrl+Shift+O mr.openInBrowser', 'Ctrl+Alt+R review.submit',
      'Ctrl+Alt+C review.comment', 'F9 review.nextThread', 'Shift+F9 review.prevThread',
    ];
    expect(want.filter((w) => !map[w])).toEqual([]);
    // Next / previous change are listed; `useChangeKeys` takes F7 itself.
    expect(all.find((a) => a.id === 'diff.nextChange')?.shortcuts).toContain('F7');
  });
});
