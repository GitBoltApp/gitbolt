import { api, errorMessage } from '../../api/client';
import type { CreateMr } from '../../api/gen/CreateMr';
import type { CreatePart } from '../../api/gen/CreatePart';
import type { ForgeKind } from '../../api/gen/ForgeKind';
import type { PartFailure } from '../../api/gen/PartFailure';
import { useToast } from '../../ui/toast';
import { mrNoun, mrRef } from '../labels';

/** A created MR/PR, with what the Retry needs (the same request, its target remote). */
export interface Created { repoId: number; remote: string; kind: ForgeKind; req: CreateMr; number: number; webUrl: string }

const PART: Record<CreatePart, string> = { reviewers: 'reviewers', assignees: 'assignees', labels: 'labels' };

/** `reviewers`, `reviewers and labels`, `reviewers, assignees and labels`. */
export function partsText(parts: CreatePart[]): string {
  const words = parts.map((p) => PART[p]);
  return words.length < 2 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

export const failureText = (failed: PartFailure[]): string => failed.map((f) => `couldn't add ${PART[f.part]}: ${f.message.replace(/\.+$/, '')}`).join('; ');

/** The outcome toast (spec #4 §3.5): "Created !12", or "PR #45 created; couldn't add reviewers:
 * <reason>" as a sticky warning with Retry for the failed parts. */
export function showCreated(c: Created, failed: PartFailure[]): void {
  const ref = mrRef(c.kind, c.number);
  const open = { label: `Open ${ref}`, run: () => { void api.openUrl(c.webUrl); } };
  if (!failed.length) {
    useToast.getState().show(`Created ${ref}`, { actions: [open] });
    return;
  }
  const retryParts = failed.map((f) => f.part);
  useToast.getState().show(`${mrNoun(c.kind)} ${ref} created; ${failureText(failed)}`, {
    tone: 'warning', sticky: true, actions: [{ label: 'Retry', run: () => { void retry(c, retryParts); } }, open],
  });
}

/** Reruns only `parts` with the same request; says what it added, or what still fails. */
const inFlight = new Set<string>();

export async function retry(c: Created, parts: CreatePart[]): Promise<void> {
  const key = `${c.repoId}:${c.remote}:${c.number}`;
  if (inFlight.has(key)) return;
  inFlight.add(key);
  try {
    await retryOnce(c, parts);
  } finally {
    inFlight.delete(key);
  }
}

async function retryOnce(c: Created, parts: CreatePart[]): Promise<void> {
  // Until the outcome replaces it: the click did something.
  useToast.getState().show('Retrying…', { sticky: true });
  let still: PartFailure[];
  try {
    still = await api.forgeCompleteCreate(c.repoId, c.remote, c.number, c.req, parts);
  } catch (e) {
    still = parts.map((part) => ({ part, message: errorMessage(e) }));
  }
  if (!still.length) {
    useToast.getState().show(`Added ${partsText(parts)} to ${mrRef(c.kind, c.number)}`);
    return;
  }
  showCreated(c, still);
}
