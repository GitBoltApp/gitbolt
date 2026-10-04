import { useEffect, useId, useRef, useState } from 'react';
import type { WriteCtx } from '../write/client';
import { closeCreateFileInput, createFile, createFilePathError } from './createFile';
import './createFile.css';

/**
 * UX round 3 O.1: the inline "new file path" input at the top of a file list, as the branch
 * name's (UX round 1). Validated live; Enter creates (the input stays, with the name, if the core
 * refuses it: it exists…), Esc cancels, and leaving it empty cancels too.
 */
export function CreateFileInput({ ctx, prefill = '' }: { ctx: WriteCtx; prefill?: string }) {
  const [value, setValue] = useState(prefill);
  const [busy, setBusy] = useState(false);
  const error = value ? createFilePathError(value) : null;
  const noteId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  // UX round 4 R.1: a folder's prefill ("foo/") has the caret at its end.
  useEffect(() => { const el = inputRef.current; if (el) el.setSelectionRange(el.value.length, el.value.length); }, []);
  const submit = async () => {
    if (busy || !value || createFilePathError(value)) return;
    setBusy(true);
    const ok = await createFile(ctx, value);
    setBusy(false);
    if (ok) closeCreateFileInput();
  };
  return (
    <div className="create-file-inline" onMouseDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.stopPropagation()}>
      <input
        className={`create-file-input${error ? ' invalid' : ''}`}
        ref={inputRef}
        autoFocus
        aria-label="New file path"
        aria-invalid={!!error || undefined}
        aria-describedby={noteId}
        placeholder="path/to/new-file"
        spellCheck={false}
        disabled={busy}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => { if (!value) closeCreateFileInput(); }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') {
            e.preventDefault();
            closeCreateFileInput();
          } else if (e.key === 'Enter') {
            e.preventDefault();
            void submit();
          }
        }}
      />
      {error
        ? <span id={noteId} className="create-file-note error" role="alert">{error}</span>
        : <span id={noteId} className="create-file-note">Enter: create · Esc: cancel · folders are made as needed</span>}
    </div>
  );
}
