import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { registerKeyHints } from '../shortcuts/hints';
import { Markdown } from './lazy';
import type { MarkdownContext, MdFlavor } from './types';
import './field.css';

export const PREVIEW_DEBOUNCE_MS = 150;

export interface MarkdownFieldProps {
  value: string;
  onChange(value: string): void;
  /** The textarea's accessible name ("Write a comment", "Description"). */
  label: string;
  flavor: MdFlavor;
  context: MarkdownContext;
  placeholder?: string;
  rows?: number;
  spellCheck?: boolean;
  autoFocus?: boolean;
  disabled?: boolean;
  /** Keys pressed in the field (the textarea or the preview): Ctrl+Enter sends from either. */
  onKeyDown?(e: KeyboardEvent<HTMLElement>): void;
  onBlur?(): void;
  /** Right of the Write/Preview tabs, in the field's header (Create's template picker). */
  toolbar?: ReactNode;
}

type Mode = 'write' | 'preview';
const isToggle = (e: KeyboardEvent<HTMLElement>) => (e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'p';

/** A textarea with Write and Preview tabs (spec §3.2), in one editor box: the tabs and an
 * optional toolbar in its header, a "Markdown supported" footer, and a focus ring around the
 * whole box. Preview renders the text (debounced by 150 ms) with the same context and rules, over
 * the textarea, which stays mounted and keeps its size, value and caret. Ctrl+Shift+P switches
 * while the field has the focus. */
export function MarkdownField({ value, onChange, label, flavor, context, placeholder, rows, spellCheck, autoFocus, disabled, onKeyDown, onBlur, toolbar }: MarkdownFieldProps) {
  const [mode, setMode] = useState<Mode>('write');
  const [shown, setShown] = useState(value);
  const area = useRef<HTMLTextAreaElement>(null);
  const pane = useRef<HTMLDivElement>(null);
  const caret = useRef<[number, number]>([0, 0]);
  useEffect(() => {
    if (mode !== 'preview' || shown === value) return;
    const t = setTimeout(() => setShown(value), PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [mode, value, shown]);
  const show = (next: Mode) => {
    if (next === mode) return;
    if (next === 'preview') {
      const a = area.current;
      if (a) caret.current = [a.selectionStart, a.selectionEnd];
      setShown(value);
    }
    setMode(next);
    setTimeout(() => {
      if (next === 'preview') pane.current?.focus({ preventScroll: true });
      else {
        const a = area.current;
        if (a) { a.focus({ preventScroll: true }); a.setSelectionRange(...caret.current); }
      }
    }, 0);
  };
  const keys = (e: KeyboardEvent<HTMLElement>) => {
    if (isToggle(e)) {
      e.preventDefault();
      e.stopPropagation();
      show(mode === 'write' ? 'preview' : 'write');
      return;
    }
    onKeyDown?.(e);
  };
  return (
    <div className="md-field" data-mode={mode} data-disabled={disabled || undefined}>
      <div className="md-field-head">
        <div className="md-field-tabs" role="tablist" aria-label={`${label}: write or preview`}>
          <button type="button" role="tab" className="md-field-tab" aria-selected={mode === 'write'} onClick={() => show('write')}>Write</button>
          <button type="button" role="tab" className="md-field-tab" aria-selected={mode === 'preview'} onClick={() => show('preview')}>Preview</button>
        </div>
        {toolbar && <div className="md-field-tools">{toolbar}</div>}
      </div>
      <div className="md-field-body">
        <textarea
          ref={area}
          aria-label={label}
          placeholder={placeholder}
          rows={rows}
          spellCheck={spellCheck}
          autoFocus={autoFocus}
          disabled={disabled}
          value={value}
          aria-hidden={mode === 'preview' || undefined}
          tabIndex={mode === 'preview' ? -1 : undefined}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={keys}
          onBlur={onBlur}
        />
        {mode === 'preview' && (
          <div ref={pane} className="md-field-preview" role="tabpanel" aria-label={`${label} preview`} tabIndex={0} onKeyDown={keys}>
            {shown.trim() ? <Markdown text={shown} flavor={flavor} context={context} /> : <p className="md-field-empty">Nothing to preview</p>}
          </div>
        )}
      </div>
      <div className="md-field-foot">
        <MarkdownMark />
        <span>Markdown supported · Ctrl+Shift+P to preview</span>
      </div>
    </div>
  );
}

/** The Markdown mark (an M and a down arrow in a box), in the text's colour. */
function MarkdownMark() {
  return (
    <svg className="md-field-mark" width="14" height="10" viewBox="0 0 208 128" aria-hidden>
      <rect x="5" y="5" width="198" height="118" rx="12" fill="none" stroke="currentColor" strokeWidth="10" />
      <path d="M30 98V30h20l20 25 20-25h20v68H90V59L70 84 50 59v39zm125 0-30-33h20V30h20v35h20z" fill="currentColor" />
    </svg>
  );
}

// Shown in the Keyboard Shortcuts panel (Ctrl+/); metadata only.
registerKeyHints([
  { id: 'key.mdPreview', section: 'Markdown', label: 'Switch between Write and Preview', keys: ['Ctrl+Shift+P'], context: '(when writing a comment or description)', source: 'markdown/MarkdownField.tsx' },
]);
