import { useEffect, type RefObject } from 'react';
import { registerKeys } from '../ui/keyRouter';
import { isEditableTarget, markEditorKey } from '../ui/keys';
import type { RepoViewStore } from './store';

/** Whether `e` (an Esc) belongs to something before the app: an editor overlay (Monaco's find
 * widget, its context menu, a hover, …) that the key was pressed in or for. */
export type EscapeOwner = (e: KeyboardEvent) => boolean;

const owners = new Set<EscapeOwner>();

/**
 * Lets `owns` claim Esc while the calling component is mounted (the diff panel's editor
 * overlays). An owner claims only a key pressed in its own area (the diff panel, or the overlay
 * itself): from anywhere else, Esc closes the file, and the overlay goes with it. While it claims
 * the key (the key router's `overlay` layer, asked by `useAppEscape` while a file is open), the
 * app's Esc leaves it alone and the key is marked (`markEditorKey`), so the overlay closes first.
 * Pass a stable function.
 */
export function useEscapeOwner(owns: EscapeOwner) {
  useEffect(() => {
    owners.add(owns);
    return () => void owners.delete(owns);
  }, [owns]);
}

const isPlainEscape = (e: KeyboardEvent) => e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && !e.isComposing;
const within = (t: Element | null, selector: string) => t?.closest(selector) != null;

/** A text box of the app's own (plan 1C's search box, …, or any editable text:
 * `isContentEditable`), whose Esc is its own. Monaco's input textarea isn't one: its Esc goes
 * through the editor's owner. */
const isTextInput = (t: Element | null) => isEditableTarget(t) && !within(t, '.monaco-editor, .monaco-host');

/**
 * The view's Esc (spec §11.1, feedback J4), from wherever the focus is: the file list, the diff,
 * the details header, the message, the graph, or nothing (`<body>`, after a click on a blank
 * area). With a file open it closes it, back to the graph with the selection kept; in the file
 * list it returns to the graph; otherwise it leaves a compare or multi-selection (K27).
 *
 * Ctrl+W isn't here: since plan 1C it's the app's one binding (`app/coreActions.ts`, through the
 * same router's `app` layer), which closes the open file if there is one, else the tab (ruling R6:
 * never both on one press). Like Esc it works from anywhere, and an open editor overlay never
 * claims it (the `overlay` layer below only asks the owners for a *plain* Esc).
 *
 * It goes through the key router (`ui/keyRouter.ts`), ahead of every handler in the page
 * (Monaco's included), and after the layers above it:
 * - `menu`: an open menu (the context menu, or any shown `[role="menu"]`) takes Esc and closes.
 *   This is the seam for every menu: render the popup with `role="menu"` and handle Esc there;
 * - `tooltip`: a shown tooltip takes this Esc (WCAG 1.4.13); the next one closes the file;
 * - `overlay`, registered here: the Esc owners (`useEscapeOwner`, the editor overlays) are asked,
 *   only while the store has a file open. A claim marks the key (`markEditorKey`) and leaves it
 *   to Monaco;
 * - `app`, registered here: the action. It leaves alone a key typed in one of the app's own text
 *   boxes (not Monaco's), and a key `defaultPrevented` before it got here — the router runs in
 *   the window's capture phase, ahead of the page's own handlers, so only a higher router layer
 *   (menu, tooltip, overlay) could have claimed it first.
 * Neither acts while `root` (the view) isn't shown: plan 1C keeps hidden tabs' views mounted in
 * `<Activity>`. When the action runs, the key goes no further, from wherever the keydown's target
 * is — including `<body>`, after a click on non-focusable content (I1).
 */
export function useAppEscape(store: RepoViewStore, root?: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const visible = (e: KeyboardEvent) => !e.defaultPrevented && root?.current?.checkVisibility?.() !== false;
    const mine = (e: KeyboardEvent) => isPlainEscape(e) && visible(e);
    // Whether a file is open is the store's `diff`, never the DOM: a closed diff panel may stay
    // mounted, hidden (its editor too). Owners are asked only while one is open.
    const offOverlay = registerKeys('overlay', (e) => {
      if (!mine(e) || store.getState().diff === null || ![...owners].some((owns) => owns(e))) return;
      markEditorKey(e);
      return 'native';
    });
    const offApp = registerKeys('app', (e) => {
      if (!mine(e)) return;
      const target = e.target instanceof Element ? e.target : null;
      if (isTextInput(target)) return;
      const s = store.getState();
      if (s.diff || within(target, '[data-focus-zone="files"]')) s.closeDiff();
      else if (s.selection.kind === 'compare' || s.selection.kind === 'compareWorktree' || s.selection.kind === 'multi') {
        s.exitCompare();
        // From the compare header (its ×, which unmounts), focus would drop to <body>.
        if (!within(target, '[data-focus-zone="graph"]')) s.setFocus('graph');
      } else return;
      e.preventDefault();
      return 'handled';
    });
    return () => {
      offOverlay();
      offApp();
    };
  }, [store, root]);
}
