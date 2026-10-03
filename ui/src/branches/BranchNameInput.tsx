import { useId, useState } from 'react';
import './branchInput.css';

/** The hint under the input while the name is fine (or empty). */
export const BRANCH_INPUT_HINT = 'Enter: create and check out · Ctrl+Enter: create only · Esc: cancel';

/**
 * The inline "enter branch name" input (UX round 1), in the commit row's Branch/Tag
 * cell (graph/rowEditor.ts). Validated live: an invalid name gets a red border and its reason
 * below. Enter creates and checks out, Ctrl/Cmd+Enter only creates, Esc cancels; leaving it empty
 * cancels too, while a typed name stays to come back to.
 */
export function BranchNameInput({ validate, onSubmit, onCancel }: { validate: (v: string) => string | null; onSubmit: (name: string, checkout: boolean) => void; onCancel: () => void }) {
  const [value, setValue] = useState('');
  const [focused, setFocused] = useState(true);
  const error = value ? validate(value) : null;
  const noteId = useId();
  return (
    <span className="branch-inline">
      <input
        className={`branch-inline-input${error ? ' invalid' : ''}`}
        autoFocus
        aria-label="Branch name"
        aria-invalid={!!error || undefined}
        aria-describedby={noteId}
        placeholder="enter branch name"
        spellCheck={false}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => { setFocused(false); if (!value) onCancel(); }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          } else if (e.key === 'Enter') {
            e.preventDefault();
            if (value && !validate(value)) onSubmit(value, !(e.ctrlKey || e.metaKey));
          }
        }}
      />
      {error
        ? <span id={noteId} className="branch-inline-note error" role="alert">{error}</span>
        : focused && <span id={noteId} className="branch-inline-note">{BRANCH_INPUT_HINT}</span>}
    </span>
  );
}
