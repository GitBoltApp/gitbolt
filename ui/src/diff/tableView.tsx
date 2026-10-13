import type { ReactNode } from 'react';
import type { DiffContentsPayload } from '../api/gen/DiffContentsPayload';
import { delimiterOf, tableDelimiterOf } from '../table/csv';
import { useTableStatus } from '../table/tableStatus';
import { MarkdownViewToggle } from './FileBody';
import { useMarkdownView } from './markdownOverride';

/**
 * The toolbar's part for a CSV or TSV file's text (`text`: its contents when the body shows them
 * as text, else null): the `Source | Table` toggle (Markdown's control, its own pick), and in Diff
 * View whether the table diff shows (`diff`: the text-diff tools are off and say why). Whether the
 * table shows is the body's word (`useTableStatus`, worked out from the text it shows): one too
 * large shows Source, and the toggle says why.
 */
export function useTableView(target: { key: string; path: string; oldPath: string | null; view: 'file' | 'diff' }, text: DiffContentsPayload | null): { toggle: ReactNode; diff: boolean } {
  const inDiff = target.view === 'diff';
  const delimiter = text === null ? null : inDiff ? tableDelimiterOf(target) : delimiterOf(target.path);
  const picked = useMarkdownView(delimiter ? target.path : null);
  const status = useTableStatus((s) => (delimiter ? s.notes[target.key] : undefined));
  if (!delimiter) return { toggle: null, diff: false };
  return { toggle: <MarkdownViewToggle path={target.path} forced={status ?? null} kind="table" />, diff: inDiff && picked === 'rendered' && status === null };
}
