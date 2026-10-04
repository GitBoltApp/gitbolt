import type { RemoteSummary } from '../api/gen/RemoteSummary';
import { openActivityEntry } from '../app/activityLog';
import { useToast, type ToastAction } from '../ui/toast';

/** The toast's "Server output (N lines)" link (spec #2 §12.4), when N (Info + Warning) > 0. */
export function serverActions(server: RemoteSummary, op: number): ToastAction[] {
  if (server.lines === 0) return [];
  return [{ label: `Server output (${server.lines} ${server.lines === 1 ? 'line' : 'lines'})`, run: () => openActivityEntry(op) }];
}

/** A push or fetch finished. With a Warning line from the server: `problem`, a warning toast that
 * stays until dismissed, quoting it. Otherwise `done`, with the link when there's output. */
export function showServerResult(done: string, problem: string, server: RemoteSummary, op: number, extra: ToastAction[] = []): void {
  // --- 4C T9: the caller's links (the push toast's "Create MR") come first ---
  const actions = [...extra, ...serverActions(server, op)];
  // --- end 4C T9 ---
  if (server.warning) {
    useToast.getState().show(problem, { tone: 'warning', sticky: true, detail: `“${server.warning}”`, actions });
    return;
  }
  useToast.getState().show(done, { actions });
}
