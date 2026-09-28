/**
 * The seam between a repo view (the startup chunk) and the shared editor (the lazy Monaco chunk)
 * for one case its attach cleanups can't cover (J16): a kept diff panel that unmounts while
 * hidden. Hiding ran the cleanup, which kept the editor because its box was still in the document;
 * React runs no cleanup again on the later unmount. The view calls `releaseDetachedEditors` when
 * it unmounts, and the host lets go of any box that has left the document (`releaseDetached`).
 * A no-op until the editor has loaded. Kept free of imports, so the startup chunk stays small.
 */
let release: (() => void) | null = null;

/** Set by the editor's loader (`useMonacoHost`) once the host exists. */
export function setEditorRelease(fn: () => void): void {
  release = fn;
}

export function releaseDetachedEditors(): void {
  release?.();
}
