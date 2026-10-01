import { create } from 'zustand';
import { useModalKeys } from '../app/modalKeys';

/** A yes/no question for a destructive or hard-to-undo action (K68: deleting a profile). */
export interface ConfirmRequest {
  title: string;
  body: string;
  confirmLabel: string;
  /** The confirm button reads as dangerous (red). */
  danger?: boolean;
}

interface Pending extends ConfirmRequest {
  resolve(ok: boolean): void;
}

const useConfirmStore = create<{ pending: Pending | null }>(() => ({ pending: null }));

/**
 * Asks, and resolves `true` only on an explicit confirm: Cancel, Esc, a click on the backdrop, or
 * a newer request all resolve `false`. Mount `<ConfirmDialog />` once (App.tsx).
 */
export function confirmAction(req: ConfirmRequest): Promise<boolean> {
  useConfirmStore.getState().pending?.resolve(false);
  return new Promise((resolve) => useConfirmStore.setState({ pending: { ...req, resolve } }));
}

export function ConfirmDialog() {
  const pending = useConfirmStore((s) => s.pending);
  if (!pending) return null;
  return <ConfirmForm pending={pending} key={pending.title + pending.body} />;
}

function ConfirmForm({ pending }: { pending: Pending }) {
  const done = (ok: boolean) => {
    useConfirmStore.setState({ pending: null });
    pending.resolve(ok);
  };
  // The trap returns focus to whatever opened the question when it closes.
  const ref = useModalKeys<HTMLDivElement>(true, () => done(false));
  return (
    <div className="modal-backdrop" onPointerDown={() => done(false)}>
      <div ref={ref} className="modal" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-body" onPointerDown={(e) => e.stopPropagation()}>
        <h2 id="confirm-title">{pending.title}</h2>
        <p id="confirm-body">{pending.body}</p>
        <div className="modal-actions">
          {/* Cancel takes the initial focus, so an Enter that was meant for something else can't confirm. */}
          <button type="button" autoFocus onClick={() => done(false)}>Cancel</button>
          <button type="button" className={pending.danger ? 'danger' : undefined} onClick={() => done(true)}>{pending.confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
