import { ArrowDown, ArrowUp, X } from 'lucide-react';
import type { KeyboardEvent } from 'react';
import { HoverTooltip } from '../ui/HoverTooltip';
import './filesFilter.css';

/**
 * "View all files"' filter row (feedback K18-K20): a compact path-substring filter, its clear
 * button, and prev/next changed-file jumps. Sits between the toolbar and the list (`FileList`),
 * shown only while "View all files" is on; the filter itself is never persisted.
 *
 * Esc: while `value` isn't empty, the input owns it and clears the filter first; empty, the input
 * lets it go to the app's Esc as usual (`onEmptyEscape`) instead of the key router's default for a
 * text input, which is to leave Esc alone entirely while focus is in one (`repo/escape.ts`'s
 * `isTextInput` gate) — so a plain Esc here would otherwise do nothing at all.
 */
export function FilesFilter({
  value,
  onChange,
  onClear,
  onPrev,
  onNext,
  canStep,
  onEmptyEscape,
}: {
  value: string;
  onChange: (v: string) => void;
  onClear: () => void;
  onPrev: () => void;
  onNext: () => void;
  canStep: boolean;
  onEmptyEscape: () => void;
}) {
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Escape' || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
    e.preventDefault();
    e.stopPropagation();
    if (value) onClear();
    else onEmptyEscape();
  };
  return (
    <div className="files-filter">
      <div className="files-filter-box">
        <input
          type="text"
          className="files-filter-input"
          placeholder="Filter files"
          aria-label="Filter files"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <HoverTooltip content="Clear filter" disabled={!value}>
          <button type="button" className="icon-button files-filter-clear" aria-label="Clear filter" disabled={!value} onClick={onClear}>
            <X size={13} />
          </button>
        </HoverTooltip>
      </div>
      <div className="files-filter-step" role="group" aria-label="Changed file navigation">
        <HoverTooltip content="Previous changed file" disabled={!canStep}>
          <button type="button" className="icon-button" aria-label="Previous changed file" disabled={!canStep} onClick={onPrev}>
            <ArrowUp size={13} />
          </button>
        </HoverTooltip>
        <HoverTooltip content="Next changed file" disabled={!canStep}>
          <button type="button" className="icon-button" aria-label="Next changed file" disabled={!canStep} onClick={onNext}>
            <ArrowDown size={13} />
          </button>
        </HoverTooltip>
      </div>
    </div>
  );
}
