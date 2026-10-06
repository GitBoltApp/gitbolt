import { ArrowDown, ArrowUp, Pilcrow, WrapText } from 'lucide-react';
import type { ReactNode } from 'react';
import { tabIdOf } from '../app/tabStores';
import { endStickyHistory } from '../history/sticky';
import { useRepoView, useRepoViewStore, type DiffTarget } from '../repo/store';
import { HoverTooltip } from '../ui/HoverTooltip';
import { useDiffPrefs, type DiffMode } from './diffPrefs';
import { changeStepper } from './changeStepper';
import { loadMonacoHost } from './monaco/load';

const MODES: [DiffMode, string][] = [['hunk', 'Hunk'], ['inline', 'Inline'], ['split', 'Split']];
/** The disabled Inline button's tooltip over a binary (lane K). */
export const BINARY_MODE_TIP = 'A binary file always shows side by side: hex and text, old and new';

/** 5C (R3): why the text-diff tools are off while the rendered Markdown diff shows. Inline and
 * Split apply to it (one column, or side by side); Hunk doesn't. */
export const RENDERED_HUNK_TIP = 'The rendered diff shows the whole document: pick Inline or Split, or Source for Hunk';
export const RENDERED_WHITESPACE_TIP = "The rendered diff already ignores whitespace that doesn't show";
export const RENDERED_WRAP_TIP = 'Rendered text always wraps';

/** Next / previous change: the rendered Markdown diff's while it shows (5C, R3), else the diff
 * editor's (F7 / Shift+F7, the toolbar arrows). */
export const goToChange = (dir: 'next' | 'previous') => {
  const step = changeStepper();
  if (step) step(dir);
  else void loadMonacoHost().then((h) => h.goToChange(dir));
};

/**
 * The diff toolbar (spec §10.1), laid out per H9: File View / Diff View centred; on
 * the right, [Blame | History] (`history`: sub-project #3's group, before prev/next), [prev | next], [Hunk | Inline | Split], [whitespace | wrap]. The left
 * column holds `leading` at its far left: the controller's "Open in…" (J1), there for images too.
 * Every pick goes through `useDiffPrefs`, which persists it (plan 1B amendment 3).
 *
 * `canStep`: a text diff is shown (not loading, an error, the large-file prompt, a binary
 * summary or File View), so Previous/Next change have something to move through.
 * `textTools`: the text-diff groups apply at all. Not for an image diff (H26), unless it's an
 * SVG's Source, which is a text diff.
 * `binary`: a hex view (lane K) is shown: always side by side, so the view mode doesn't apply
 * (the Inline button says why), and neither do whitespace or wrapping.
 * `markdown`: File View's `Source | Rendered` toggle for a Markdown file (spec #5 §3.3), first in
 * the right group (it grows leftward, so nothing after it moves).
 * `rendered`: the rendered Markdown diff shows (5C): Inline and Split pick its layout (the same
 * saved mode); Hunk, whitespace and wrap stay in place, off, and say why.
 * `views`: another view switch in File View / Diff View's place (File History's `File | Changes`).
 */
export function DiffToolbar({ target, canDiff, canStep, textTools = true, binary = false, rendered = false, leading, staging, history, markdown, views }: { target: DiffTarget; canDiff: boolean; canStep: boolean; textTools?: boolean; binary?: boolean; rendered?: boolean; leading?: ReactNode; staging?: ReactNode; history?: ReactNode; markdown?: ReactNode; views?: ReactNode }) {
  const prefs = useDiffPrefs((s) => s.prefs);
  const setPrefs = useDiffPrefs((s) => s.set);
  const store = useRepoViewStore();
  const setView = useRepoView((s) => s.setView);
  // A view picked here is the user's: File History stops being sticky (UX), even for the pressed one.
  const pick = (view: DiffTarget['view']) => {
    endStickyHistory(tabIdOf(store));
    setView(view);
  };
  const inDiff = target.view === 'diff';
  // The rendered Markdown diff is Split or one column (Inline): a Hunk pick shows it as Inline.
  const mode: DiffMode = rendered && !binary && prefs.mode === 'hunk' ? 'inline' : prefs.mode;
  return (
    // preventDefault on mouse-down: buttons still click, but focus stays where it was (usually the
    // file list), so Up/Down keeps switching files (spec §10.1).
    <div className="diff-toolbar" role="toolbar" aria-label="Diff options" onMouseDown={(e) => e.preventDefault()}>
      <div className="diff-toolbar-start">{leading}</div>
      {views ?? (
        <div className="segmented">
          <button type="button" aria-pressed={!inDiff} onClick={() => pick('file')}>File View</button>
          <button type="button" aria-pressed={inDiff} disabled={!canDiff} onClick={() => pick('diff')}>Diff View</button>
        </div>
      )}
      <div className="diff-toolbar-end">
        {markdown}
        {staging}
        {history}
        {textTools && (
          <>
            <div className="diff-toolbar-group" role="group" aria-label="Changes">
              <IconButton label="Previous change" tip="Previous change (Shift+F7)" disabled={!canStep} onClick={() => goToChange('previous')}><ArrowUp size={14} /></IconButton>
              <IconButton label="Next change" tip="Next change (F7)" disabled={!canStep} onClick={() => goToChange('next')}><ArrowDown size={14} /></IconButton>
            </div>
            <div className="segmented" role="group" aria-label="View mode">
              {MODES.map(([m, label]) => binary || (rendered && m === 'hunk')
                // `aria-disabled`, so the tooltip still shows on hover.
                ? <HoverTooltip key={m} content={binary ? BINARY_MODE_TIP : RENDERED_HUNK_TIP} disabled={binary && m !== 'inline'}><button type="button" aria-pressed={!rendered && prefs.mode === m} aria-disabled="true">{label}</button></HoverTooltip>
                : <button key={m} type="button" aria-pressed={mode === m} disabled={!inDiff} onClick={() => setPrefs({ mode: m })}>{label}</button>)}
            </div>
            <div className="diff-toolbar-group" role="group" aria-label="Display">
              <IconToggle label="Ignore whitespace" tip="Ignore leading and trailing whitespace" pressed={prefs.ignoreWhitespace} disabled={!inDiff || binary} blockedTip={rendered && !binary ? RENDERED_WHITESPACE_TIP : undefined} onClick={() => setPrefs({ ignoreWhitespace: !prefs.ignoreWhitespace })}><Pilcrow size={14} /></IconToggle>
              <IconToggle label="Word wrap" tip="Word wrap" pressed={prefs.wordWrap} disabled={binary} blockedTip={rendered && !binary ? RENDERED_WRAP_TIP : undefined} onClick={() => setPrefs({ wordWrap: !prefs.wordWrap })}><WrapText size={14} /></IconToggle>
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

/** An icon-only toggle: its name is `label` (for screen readers) and `tip` (a hover tooltip).
 * `blockedTip`: it doesn't apply now (5C); it stays in place, `aria-disabled`, saying why. */
function IconToggle({ label, tip, pressed, disabled, blockedTip, onClick, children }: { label: string; tip: string; pressed: boolean; disabled?: boolean; blockedTip?: string; onClick: () => void; children: ReactNode }) {
  const blocked = blockedTip !== undefined;
  return (
    <HoverTooltip content={blocked ? blockedTip : tip} disabled={!blocked && disabled}>
      <button type="button" className="icon-button toggle-icon" aria-label={label} aria-pressed={pressed} disabled={!blocked && disabled} aria-disabled={blocked ? 'true' : undefined} onClick={blocked ? undefined : onClick}>{children}</button>
    </HoverTooltip>
  );
}
