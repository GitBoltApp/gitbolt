import { copyAndSay as copy, openDebug } from '../app/activityLog';
import { actionsFor, describeError, toGbError, type ErrorAction, type ErrorContext } from '../errors/describe';
import { ERROR_TOAST_MS, useToast, type ToastAction } from '../ui/toast';

const CONTEXT_ACTIONS: ReadonlySet<ErrorAction['id']> = new Set(['retry', 'refresh', 'remove-recent']);

/**
 * A user's action failed (R12): the existing toast, for `ERROR_TOAST_MS`, with `describeError`'s
 * text and two links: Retry/Refresh/Remove from recent when `ctx` offers the kind's one, else Copy
 * error; then Details, which opens the Debug modal's Commands tab at the failed git command, or
 * its Actions tab when no command is linked. A cancel says nothing. Background errors don't come
 * here: they stay in the bell (K30).
 */
export function toastActionError(e: unknown, ctx: ErrorContext = {}): void {
  const err = toGbError(e);
  const d = describeError(err);
  if (!d) return;
  const suggested = actionsFor(err, ctx, { openDetails: (id) => openDebug('commands', id), copy });
  const first: ErrorAction = suggested.find((a) => CONTEXT_ACTIONS.has(a.id))
    ?? suggested.find((a) => a.id === 'copy')
    ?? { id: 'copy', label: 'Copy error', run: () => copy([d.title, d.message, err.stderr].filter(Boolean).join('\n')) };
  const details: ErrorAction = suggested.find((a) => a.id === 'details') ?? { id: 'details', label: 'Details', run: () => openDebug('actions') };
  // A context action may fail again (a Retry): that failure toasts the same way.
  const link = (a: ErrorAction): ToastAction => ({
    label: a.label,
    run: () => {
      try {
        void Promise.resolve(a.run()).catch((again: unknown) => toastActionError(again, ctx));
      } catch (again) {
        toastActionError(again, ctx);
      }
    },
  });
  useToast.getState().show(`${d.title}: ${d.message}`, { ms: ERROR_TOAST_MS, actions: [link(first), link(details)] });
}
