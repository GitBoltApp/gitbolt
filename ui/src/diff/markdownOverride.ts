import { create } from 'zustand';
import { useDiffPrefs, type MarkdownView } from './diffPrefs';

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

/** The view `path` shows: Source while it's the just-created file, else the app-wide pick. */
export const markdownViewOf = (path: string | null): MarkdownView =>
  path !== null && useMarkdownOverride.getState().path === path ? 'source' : useDiffPrefs.getState().prefs.markdownView;

export function useMarkdownView(path: string | null): MarkdownView {
  const picked = useDiffPrefs((s) => s.prefs.markdownView);
  const over = useMarkdownOverride((s) => s.path);
  return path !== null && over === path ? 'source' : picked;
}
