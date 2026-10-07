import type * as MonacoNs from 'monaco-editor/editor/editor.api';
import { copyText } from '../../api/transport';
import { useToast } from '../../ui/toastStore';
import { monaco } from './setup';

const squash = (s: string) => s.replace(/\s+/g, '');

/**
 * The index into `lines` of rendered segment `at`, where `segments` are `lines` as Monaco draws
 * them in a deleted-lines zone: one segment per line, or several when a line wraps. Matched by
 * text with whitespace removed (a tab renders as spaces, a space as a no-break space).
 */
export function lineOfSegment(segments: string[], lines: string[], at: number): number {
  let seg = 0;
  for (let i = 0; i < lines.length; i++) {
    const want = squash(lines[i]).length;
    let have = 0;
    do have += squash(segments[seg++] ?? '').length;
    while (have < want && seg < segments.length);
    if (at < seg) return i;
  }
  return lines.length - 1;
}

/** The change whose old lines a deleted-lines zone after modified line `after` shows: old lines
 * show after the line above the change; a pure deletion reports that line itself. */
export function zoneChange(diff: MonacoNs.editor.IDiffEditor, after: number): MonacoNs.editor.ILineChange | undefined {
  return diff.getLineChanges()?.find((c) => c.originalEndLineNumber > 0 && (c.modifiedEndLineNumber === 0 ? c.modifiedStartLineNumber : c.modifiedStartLineNumber - 1) === after);
}

/**
 * A click on deleted lines (F25): in Inline and Hunk mode Monaco draws a change's old
 * lines in a view zone, which the editor's own selection skips. A click there copies the clicked
 * line; Shift+click copies the whole deleted block. A drag that selects text in the zone is left
 * to Monaco, which copies that selection itself. Uses only the public API: the modified editor's
 * mouse events (whose zone target carries `afterLineNumber`, in model lines) and the diff's line
 * changes.
 */
export function enableDeletedLineCopy(diff: MonacoNs.editor.IStandaloneDiffEditor): MonacoNs.IDisposable {
  const editor = diff.getModifiedEditor();
  return editor.onMouseUp((e) => {
    if (e.target.type !== monaco.editor.MouseTargetType.CONTENT_VIEW_ZONE || !e.event.leftButton) return;
    const clicked = e.target.element;
    const zone = clicked?.closest('.line-delete');
    if (!clicked || !zone) return;
    const sel = globalThis.getSelection?.();
    // Shift+click extends selections on its way, the page's text selection and Monaco's own (its
    // mouse-down moves the cursor to the zone): drop the first, collapse the second to its anchor.
    if (e.event.shiftKey) {
      sel?.removeAllRanges();
      const own = editor.getSelection();
      if (own && !own.isEmpty()) editor.setPosition({ lineNumber: own.selectionStartLineNumber, column: own.selectionStartColumn });
    } else if (sel && !sel.isCollapsed) return;
    const change = zoneChange(diff, e.target.detail.afterLineNumber);
    const model = diff.getOriginalEditor().getModel();
    if (!change || !model) return;
    const lines: string[] = [];
    for (let n = change.originalStartLineNumber; n <= change.originalEndLineNumber; n++) lines.push(model.getLineContent(n));
    let picked = lines;
    if (!e.event.shiftKey) {
      const segments = [...zone.querySelectorAll('.view-line')];
      const at = segments.findIndex((s) => s.contains(clicked));
      if (at < 0) return;
      picked = [lines[lineOfSegment(segments.map((s) => s.textContent ?? ''), lines, at)]];
    }
    const toast = useToast.getState().show;
    copyText(picked.join('\n')).then(
      () => toast(`Copied ${picked.length} line${picked.length === 1 ? '' : 's'}`),
      () => toast('Copy failed'),
    );
  });
}
