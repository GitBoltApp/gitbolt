import { ArrowDown, ArrowUp, Pilcrow, WrapText } from 'lucide-react';
import type { ReactNode } from 'react';
import { useRepoView, type DiffTarget } from '../repo/store';
import { HoverTooltip } from '../ui/HoverTooltip';
import { useDiffPrefs, type DiffMode } from './diffPrefs';
import { loadMonacoHost } from './monaco/load';

const MODES: [DiffMode, string][] = [['hunk', 'Hunk'], ['inline', 'Inline'], ['split', 'Split']];

/** Next / previous change in the diff editor (F7 / Shift+F7, the toolbar arrows). */
export const goToChange = (dir: 'next' | 'previous') => void loadMonacoHost().then((h) => h.goToChange(dir));

/**
 * The diff toolbar (spec §10.1), laid out per H9: File View / Diff View centred; on
 * the right, [Blame | History] (sub-project #3 adds them before prev/next; nothing renders
 * now: no placeholders), [prev | next], [Hunk | Inline | Split], [whitespace | wrap]. The left
 * column is empty: the header above has the path and the "Open in…" slot. Every pick goes
 * through `useDiffPrefs`, which persists it (plan 1B amendment 3).
 *
 * `canStep`: a text diff is shown (not loading, an error, the large-file prompt, a binary
 * summary or File View), so Previous/Next change have something to move through.
 * `textTools`: the text-diff groups apply at all. Not for an image diff (H26), unless it's an
 * SVG's Source, which is a text diff.
 */
export function DiffToolbar({ target, canDiff, canStep, textTools = true }: { target: DiffTarget; canDiff: boolean; canStep: boolean; textTools?: boolean }) {
  const prefs = useDiffPrefs((s) => s.prefs);
  const setPrefs = useDiffPrefs((s) => s.set);
  const setView = useRepoView((s) => s.setView);
  const inDiff = target.view === 'diff';
  return (
    // preventDefault on mouse-down: buttons still click, but focus stays where it was (usually the
    // file list), so Up/Down keeps switching files (spec §10.1).
    <div className="diff-toolbar" role="toolbar" aria-label="Diff options" onMouseDown={(e) => e.preventDefault()}>
      <div className="diff-toolbar-start" />
      <div className="segmented">
        <button type="button" aria-pressed={!inDiff} onClick={() => setView('file')}>File View</button>
        <button type="button" aria-pressed={inDiff} disabled={!canDiff} onClick={() => setView('diff')}>Diff View</button>
      </div>
      <div className="diff-toolbar-end">
        {textTools && (
          <>
            <div className="diff-toolbar-group" role="group" aria-label="Changes">
              <IconButton label="Previous change" tip="Previous change (Shift+F7)" disabled={!canStep} onClick={() => goToChange('previous')}><ArrowUp size={14} /></IconButton>
              <IconButton label="Next change" tip="Next change (F7)" disabled={!canStep} onClick={() => goToChange('next')}><ArrowDown size={14} /></IconButton>
            </div>
            <div className="segmented" role="group" aria-label="View mode">
              {MODES.map(([m, label]) => (
                <button key={m} type="button" aria-pressed={prefs.mode === m} disabled={!inDiff} onClick={() => setPrefs({ mode: m })}>{label}</button>
              ))}
            </div>
            <div className="diff-toolbar-group" role="group" aria-label="Display">
              <IconToggle label="Ignore whitespace" tip="Ignore leading and trailing whitespace" pressed={prefs.ignoreWhitespace} disabled={!inDiff} onClick={() => setPrefs({ ignoreWhitespace: !prefs.ignoreWhitespace })}><Pilcrow size={14} /></IconToggle>
              <IconToggle label="Word wrap" tip="Word wrap" pressed={prefs.wordWrap} onClick={() => setPrefs({ wordWrap: !prefs.wordWrap })}><WrapText size={14} /></IconToggle>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** An icon-only button: its name is `label` (for screen readers) and `tip` (a hover tooltip). */
function IconButton({ label, tip, disabled, onClick, children }: { label: string; tip: string; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <HoverTooltip content={tip} disabled={disabled}>
      <button type="button" className="icon-button" aria-label={label} disabled={disabled} onClick={onClick}>{children}</button>
    </HoverTooltip>
  );
}

/** An icon-only toggle: its name is `label` (for screen readers) and `tip` (a hover tooltip). */
function IconToggle({ label, tip, pressed, disabled, onClick, children }: { label: string; tip: string; pressed: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <HoverTooltip content={tip} disabled={disabled}>
      <button type="button" className="icon-button toggle-icon" aria-label={label} aria-pressed={pressed} disabled={disabled} onClick={onClick}>{children}</button>
    </HoverTooltip>
  );
}
