import { ArrowDown, ArrowUp } from 'lucide-react';
import { useRepoView, type DiffTarget } from '../repo/store';
import { useDiffPrefs, type DiffMode } from './diffPrefs';
import { loadMonacoHost } from './monaco/load';

const MODES: [DiffMode, string][] = [['hunk', 'Hunk'], ['inline', 'Inline'], ['split', 'Split']];

/** Next / previous change in the diff editor (F7 / Shift+F7, the toolbar arrows). */
export const goToChange = (dir: 'next' | 'previous') => void loadMonacoHost().then((h) => h.goToChange(dir));

/**
 * The diff toolbar (spec §10.1). Every pick goes through `useDiffPrefs`, which persists it
 * (plan 1B amendment 3). There's no Blame or History (#3) and no "Edit this file" (#2): no
 * placeholders.
 */
/** `canStep`: a text diff is shown (not loading, an error, the large-file prompt, a binary
 * summary or File View), so Previous/Next change have something to move through. */
export function DiffToolbar({ target, canDiff, canStep }: { target: DiffTarget; canDiff: boolean; canStep: boolean }) {
  const prefs = useDiffPrefs((s) => s.prefs);
  const setPrefs = useDiffPrefs((s) => s.set);
  const setView = useRepoView((s) => s.setView);
  const inDiff = target.view === 'diff';
  return (
    // preventDefault on mouse-down: buttons still click, but focus stays where it was (usually the
    // file list), so Up/Down keeps switching files (spec §10.1).
    <div className="diff-toolbar" role="toolbar" aria-label="Diff options" onMouseDown={(e) => e.preventDefault()}>
      <div className="segmented">
        <button type="button" aria-pressed={!inDiff} onClick={() => setView('file')}>File View</button>
        <button type="button" aria-pressed={inDiff} disabled={!canDiff} onClick={() => setView('diff')}>Diff View</button>
      </div>
      <button type="button" className="icon-button" aria-label="Previous change" title="Previous change (Shift+F7)" disabled={!canStep} onClick={() => goToChange('previous')}><ArrowUp size={14} /></button>
      <button type="button" className="icon-button" aria-label="Next change" title="Next change (F7)" disabled={!canStep} onClick={() => goToChange('next')}><ArrowDown size={14} /></button>
      <div className="segmented" role="group" aria-label="View mode">
        {MODES.map(([m, label]) => (
          <button key={m} type="button" aria-pressed={prefs.mode === m} disabled={!inDiff} onClick={() => setPrefs({ mode: m })}>{label}</button>
        ))}
      </div>
      <button type="button" className="toggle" aria-pressed={prefs.ignoreWhitespace} disabled={!inDiff} title="Ignore leading and trailing whitespace" onClick={() => setPrefs({ ignoreWhitespace: !prefs.ignoreWhitespace })}>Ignore whitespace ¶</button>
      <button type="button" className="toggle" aria-pressed={prefs.wordWrap} onClick={() => setPrefs({ wordWrap: !prefs.wordWrap })}>Word wrap</button>
    </div>
  );
}
