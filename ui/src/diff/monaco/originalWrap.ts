import type * as MonacoNs from 'monaco-editor/editor/editor.api';

/**
 * Word wrap on the original (left) side of a side-by-side diff. In inline mode Monaco hides that
 * editor and forces `wordWrapOverride2: 'off'` on it, but going back to side by side (the Split
 * mode, or a panel widened past the inline breakpoint) never clears it, so the left side stopped
 * wrapping while the right one did. Whenever the original editor is laid out visibly again, the
 * override goes back to `inherit`, so it follows the diff's word wrap.
 */
export function keepOriginalWrap(original: MonacoNs.editor.ICodeEditor, option: MonacoNs.editor.EditorOption.wordWrapOverride2): MonacoNs.IDisposable {
  const restore = () => {
    if (original.getLayoutInfo().width > 0 && original.getOption(option) === 'off') original.updateOptions({ wordWrapOverride2: 'inherit' });
  };
  return original.onDidLayoutChange(restore);
}
