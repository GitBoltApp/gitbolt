import { useRef, type KeyboardEvent } from 'react';
import { flushDrafts, WIP_DRAFT_COUNTER_FROM, WIP_DRAFT_WARN_FROM, type WipDraft } from './draft';
import './commit.css';

const isSubmit = (e: KeyboardEvent) => e.key === 'Enter' && (e.ctrlKey || e.metaKey);

/**
 * The summary line and the description below it (spec #2 §8.1), the WIP draft's two fields.
 * - Enter or ↓ in the summary moves to the description (caret at its start).
 * - ↑ with the caret on the description's first line moves back (caret at the summary's end).
 * - Ctrl+Enter submits from either; Esc blurs, keeping the text (or `onEscape`, e.g. Cancel).
 * The description grows to 8 lines, then scrolls (CSS `field-sizing`).
 * Keys typed here never reach the app's shortcuts (the same rule as the WIP row's box).
 */
export function CommitFields({ value, onChange, onSubmit, onEscape, disabled = false, autoFocus = false }: { value: WipDraft; onChange: (d: WipDraft) => void; onSubmit: () => void; onEscape?: () => void; disabled?: boolean; autoFocus?: boolean }) {
  const summary = useRef<HTMLInputElement>(null);
  const description = useRef<HTMLTextAreaElement>(null);
  const escape = (e: KeyboardEvent<HTMLElement>) => {
    e.preventDefault();
    if (onEscape) onEscape();
    else {
      e.currentTarget.blur();
      flushDrafts();
    }
  };
  const onSummaryKey = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (isSubmit(e)) {
      e.preventDefault();
      onSubmit();
    } else if (e.key === 'Enter' || e.key === 'ArrowDown') {
      e.preventDefault();
      description.current?.focus();
      description.current?.setSelectionRange(0, 0);
    } else if (e.key === 'Escape') escape(e);
  };
  const onDescriptionKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    e.stopPropagation();
    const t = e.currentTarget;
    if (isSubmit(e)) {
      e.preventDefault();
      onSubmit();
    } else if (e.key === 'ArrowUp' && t.selectionStart === t.selectionEnd && !t.value.slice(0, t.selectionStart).includes('\n')) {
      e.preventDefault();
      const s = summary.current;
      s?.focus();
      s?.setSelectionRange(s.value.length, s.value.length);
    } else if (e.key === 'Escape') escape(e);
  };
  const n = value.summary.length;
  return (
    <div className="commit-fields">
      <div className="commit-summary-row">
        <input
          ref={summary}
          className="commit-summary"
          type="text"
          aria-label="Commit summary"
          placeholder="Summary"
          spellCheck={false}
          autoComplete="off"
          autoFocus={autoFocus}
          disabled={disabled}
          value={value.summary}
          onChange={(e) => onChange({ ...value, summary: e.target.value })}
          onKeyDown={onSummaryKey}
          onBlur={flushDrafts}
        />
        {n > WIP_DRAFT_COUNTER_FROM && <span className={`commit-counter${n > WIP_DRAFT_WARN_FROM ? ' warn' : ''}`} data-testid="commit-counter">{n}</span>}
      </div>
      <textarea
        ref={description}
        className="commit-description"
        aria-label="Commit description"
        placeholder="Description"
        spellCheck={false}
        disabled={disabled}
        value={value.description}
        onChange={(e) => onChange({ ...value, description: e.target.value })}
        onKeyDown={onDescriptionKey}
        onBlur={flushDrafts}
      />
    </div>
  );
}
