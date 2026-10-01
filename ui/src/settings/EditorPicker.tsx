import { useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../api/client';
import type { EditorChoice } from '../api/gen/EditorChoice';
import { Select } from '../ui/Select';
import { refreshOpeners, useOpeners } from '../openIn/openers';

const CUSTOM = 'custom';
const VALIDATE_DELAY_MS = 300;

/**
 * The editor picker of the profile (and, with `inherit`, of one repository): "Last used" (or
 * "Same as the profile"), a detected editor, or a Custom command template (R5).
 *
 * A template is checked by the backend with the same guard an open runs it through (a shell or
 * interpreter's code argument can't hold {file}, {line} or {repo}; the program must exist), and
 * the refusal shows right under the field. Only a template that passes is saved, so Open in never
 * meets one it would refuse; the draft stays in the field meanwhile.
 */
export function EditorPicker({ id, value, onChange, inherit }: { id: string; value: EditorChoice | null; onChange(v: EditorChoice | null): void; inherit: boolean }) {
  const openers = useOpeners();
  const editors = (openers ?? []).filter((o) => o.kind === 'editor' && o.id !== CUSTOM);
  const saved = value?.kind === 'custom' ? value.template : '';
  const [custom, setCustom] = useState(value?.kind === 'custom');
  const [draft, setDraft] = useState(saved);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  // What this picker last saved: the echo of it coming back as `value` isn't an outside change.
  const emitted = useRef<string | null>(null);
  const emit = (v: EditorChoice | null) => {
    emitted.current = JSON.stringify(v);
    onChange(v);
  };

  // The saved value changed from outside (another profile, a reset): follow it.
  useEffect(() => {
    if (JSON.stringify(value) === emitted.current) return;
    setCustom(value?.kind === 'custom');
    setDraft(value?.kind === 'custom' ? value.template : '');
    setError(null);
  }, [value]);

  const selected = custom ? CUSTOM : value?.kind === 'opener' ? value.id : '';
  const choose = (v: string) => {
    seq.current++;
    setError(null);
    if (v === CUSTOM) {
      setCustom(true);
      // Back to a template that was saved before; otherwise wait for a valid one.
      return;
    }
    setCustom(false);
    emit(v === '' ? null : { kind: 'opener', id: v });
    refreshOpeners().catch(() => {});
  };

  const edit = (template: string) => {
    setDraft(template);
    const mine = ++seq.current;
    if (!template.trim()) {
      setError(null);
      return;
    }
    setTimeout(() => {
      if (mine !== seq.current) return;
      api.validateEditorTemplate(template).then(
        () => {
          if (mine !== seq.current) return;
          setError(null);
          emit({ kind: 'custom', template });
          // The Custom entry joins (or leaves) the Open in menus.
          refreshOpeners().catch(() => {});
        },
        (e: unknown) => { if (mine === seq.current) setError(errorMessage(e)); },
      );
    }, VALIDATE_DELAY_MS);
  };

  return (
    <div className="editor-picker">
      <Select id={`input-${id}`} value={selected} onChange={choose} options={[
        ['', inherit ? 'Same as the profile' : 'Last used'],
        ...editors.map((o) => [o.id, o.name] as const),
        ...(value?.kind === 'opener' && !editors.some((o) => o.id === value.id) ? [[value.id, `${value.id} (not found)`] as const] : []),
        [CUSTOM, 'Custom command…'],
      ]} />
      {custom && (
        <>
          <input
            aria-label="Custom editor command"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `error-${id}` : undefined}
            placeholder="myeditor --goto {file}:{line}"
            spellCheck={false}
            value={draft}
            onChange={(e) => edit(e.target.value)}
          />
          {error
            ? <div id={`error-${id}`} className="setting-error" role="alert">{error}</div>
            : <div className="setting-hint">{'{file}'}, {'{line}'} and {'{repo}'} are filled in per open.</div>}
        </>
      )}
    </div>
  );
}
