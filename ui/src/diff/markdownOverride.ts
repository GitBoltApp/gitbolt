import { create } from 'zustand';
import { useDiffPrefs, type MarkdownView, type ViewPref } from './diffPrefs';
import { VIEW_PREFS, viewKindOf } from './markdownFiles';

/**
 * A just-created Markdown file shows Source (it's made to be typed into) without touching the
 * app-wide `markdownView`: every other Markdown file still opens the way that says. The exception
 * is one path; it ends when another file is shown or the Source | Rendered toggle is used.
 */
export const useMarkdownOverride = create<{ path: string | null }>(() => ({ path: null }));

/** `path` shows Source until another file is shown or the toggle is used. */
export const showSourceFor = (path: string): void => useMarkdownOverride.setState({ path });

export function clearMarkdownOverride(): void {
  if (useMarkdownOverride.getState().path !== null) useMarkdownOverride.setState({ path: null });
}

/** The app-wide pick `path` follows, by its kind (`viewKindOf`): Markdown's (`markdownView`, also
 * for none named), HTML's (`htmlView`), or a CSV or TSV file's (`tableView`). */
export const viewPrefOf = (path: string | null): ViewPref => VIEW_PREFS[(path !== null ? viewKindOf(path) : null) ?? 'markdown'];

/** Picks `view` for the kind of file `path` is (and ends a just-created file's Source). */
export function pickViewFor(path: string | null, view: MarkdownView): void {
  clearMarkdownOverride();
  useDiffPrefs.getState().set({ [viewPrefOf(path)]: view });
}

/** The view `path` shows: Source while it's the just-created file, else its kind's app-wide pick. */
export const markdownViewOf = (path: string | null): MarkdownView =>
  path !== null && useMarkdownOverride.getState().path === path ? 'source' : useDiffPrefs.getState().prefs[viewPrefOf(path)];

export function useMarkdownView(path: string | null): MarkdownView {
  const picked = useDiffPrefs((s) => s.prefs[viewPrefOf(path)]);
  const over = useMarkdownOverride((s) => s.path);
  return path !== null && over === path ? 'source' : picked;
}
