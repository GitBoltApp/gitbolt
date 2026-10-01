import { KeyRound } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { useOps, type AuthPrompt } from '../app/ops';
import { useMenu } from '../menu/menuStore';
import { pushModal } from '../app/modalKeys';
import { registerKeys } from '../ui/keyRouter';
import { closePickers } from '../ui/RefPicker';
import './auth.css';

/**
 * Spec §5.4: git's (or ssh's) credential prompt, one at a time; the credential helper decides
 * whether anything is remembered. Only user-started ops ever get here: GitBolt's own background
 * fetches never prompt (their askpass calls are refused, Review Focus 3).
 */
export function AuthModal() {
  const prompt = useOps((s) => s.prompts[0]);
  const open = !!prompt;
  // The focus goes back where it was once the last prompt closes (a username, then a password
  // prompt, is one stretch). Read while rendering the first prompt: by the effects, `autoFocus`
  // has already moved it into the field.
  const [before, setBefore] = useState<HTMLElement | null>(null);
  if (open && !before && document.activeElement instanceof HTMLElement && document.activeElement !== document.body) setBefore(document.activeElement);
  // Opening takes the keyboard over: an open context menu or picker closes, so the modal is the
  // only thing in the key router's `menu` layer.
  useLayoutEffect(() => {
    if (!open) return;
    useMenu.getState().close();
    closePickers();
  }, [open]);
  useEffect(() => {
    if (open || !before) return;
    if (before.isConnected) before.focus({ preventScroll: true });
    setBefore(null);
  }, [open, before]);
  return prompt ? <AuthForm key={prompt.prompt} prompt={prompt} /> : null;
}

const FOCUSABLE = 'input, button:not(:disabled)';

function AuthForm({ prompt }: { prompt: AuthPrompt }) {
  const [value, setValue] = useState('');
  const form = useRef<HTMLFormElement>(null);
  const answer = (v: string | null) => {
    // A prompt the backend no longer has (answered, or its op ended) would otherwise stay up.
    void api.authAnswer(prompt.prompt, v).catch(() => useOps.getState().apply({ type: 'authResolved', prompt: prompt.prompt }));
  };

  // While open it owns the keyboard (ruling R6): it's in the key router's `menu` layer, so no key
  // reaches the app behind it (Esc never also closes the open file, Ctrl+W never closes the tab).
  // Esc cancels the prompt; Tab stays inside it; every other key goes on to the field and buttons.
  const keys = useRef<(e: KeyboardEvent) => 'handled' | 'native'>(() => 'native');
  keys.current = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      answer(null);
      return 'handled';
    }
    if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      const els = [...(form.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
      if (els.length) {
        const i = els.indexOf(document.activeElement as HTMLElement);
        els[(i + (e.shiftKey ? -1 : 1) + els.length) % els.length].focus();
      }
      e.preventDefault();
      return 'handled';
    }
    return 'native';
  };
  // On top of the dialog stack (a prompt can arrive while Settings or the Palette is open): the
  // dialogs under it stay up but inert, and get their keys back when this closes.
  useEffect(() => {
    const pop = pushModal(form);
    const off = registerKeys('menu', (e) => keys.current(e));
    return () => {
      off();
      pop();
    };
  }, []);

  const text = prompt.text.trim();
  return (
    <div className="modal-backdrop auth-backdrop">
      <form
        ref={form}
        className="modal auth-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Authentication required"
        aria-describedby={`auth-text-${prompt.prompt}`}
        onSubmit={(e) => { e.preventDefault(); answer(value); }}
      >
        <h2><KeyRound size={16} aria-hidden /> Authentication required</h2>
        <p className="auth-prompt" id={`auth-text-${prompt.prompt}`}>{text}</p>
        <input
          autoFocus
          autoComplete="off"
          spellCheck={false}
          type={prompt.secret ? 'password' : 'text'}
          aria-label={prompt.secret ? 'Password' : 'Answer'}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <p className="auth-note">Remembering credentials is up to your git credential helper.</p>
        <div className="modal-actions">
          <button type="button" onClick={() => answer(null)}>Cancel</button>
          <button type="submit" className="primary">OK</button>
        </div>
      </form>
    </div>
  );
}
