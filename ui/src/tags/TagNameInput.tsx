import { useId, useState, type KeyboardEvent } from 'react';
import '../branches/branchInput.css';
import './tags.css';

export const TAG_INPUT_HINT = 'Enter: create the tag · Esc: cancel';
export const TAG_NAME_NEXT_HINT = 'Enter: write its message · Esc: cancel';
export const TAG_MESSAGE_HINT = 'Enter: create the tag · Shift+Enter: new line · Esc: cancel';

/**
 * "Create tag here" (spec #3 §3.9): the inline input in the commit row's Branch/Tag cell, as 2C's
 * branch input is (graph/rowEditor.ts), its classes reused. A lightweight tag: Enter creates. An
 * annotated one: Enter moves to the message box floated under it (out of the flow: no row
 * moves), where Enter creates and Shift+Enter starts a new line. Esc cancels; leaving an empty
 * name cancels too.
 */
export function TagNameInput({ annotated, validate, onSubmit, onCancel }: { annotated: boolean; validate: (v: string) => string | null; onSubmit: (name: string, message: string | null) => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const [step, setStep] = useState<'name' | 'message'>('name');
  const [focused, setFocused] = useState(true);
  const error = name ? validate(name) : null;
  const noteId = useId();
  const escape = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key !== 'Escape') return false;
    e.preventDefault();
    onCancel();
    return true;
  };
  const hint = step === 'message' ? TAG_MESSAGE_HINT : annotated ? TAG_NAME_NEXT_HINT : TAG_INPUT_HINT;
  const note = error
    ? <span id={noteId} className="branch-inline-note error" role="alert">{error}</span>
    : (focused || step === 'message') && <span id={noteId} className="branch-inline-note">{hint}</span>;
  return (
    <span className="branch-inline">
      <input
        className={`branch-inline-input tag-inline-input${error ? ' invalid' : ''}`}
        autoFocus
        aria-label="Tag name"
        aria-invalid={!!error || undefined}
        aria-describedby={noteId}
        placeholder={annotated ? 'enter annotated tag name' : 'enter tag name'}
        spellCheck={false}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => { setFocused(false); if (!name) onCancel(); }}
        onKeyDown={(e) => {
          if (escape(e) || e.key !== 'Enter') return;
          e.preventDefault();
          if (!name || validate(name)) return;
          if (annotated) setStep('message');
          else onSubmit(name, null);
        }}
      />
      {step === 'message'
        ? (
          <span className="tag-inline-below">
            <textarea
              className="tag-inline-message"
              autoFocus
              aria-label="Tag message"
              placeholder="tag message"
              rows={3}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if (escape(e) || e.key !== 'Enter' || e.shiftKey) return;
                e.preventDefault();
                if (message.trim()) onSubmit(name, message);
              }}
            />
            {note}
          </span>
        )
        : note}
    </span>
  );
}
