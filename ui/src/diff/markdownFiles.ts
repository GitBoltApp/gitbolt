/** Spec #5 §3.3: the extensions File View can show rendered. */
export const MARKDOWN_EXTENSIONS = ['md', 'markdown', 'mdx'] as const;

/** Whether File View offers `Source | Rendered` for `path` (its file name has a Markdown extension). */
export function isMarkdownPath(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 && (MARKDOWN_EXTENSIONS as readonly string[]).includes(name.slice(dot + 1).toLowerCase());
}
