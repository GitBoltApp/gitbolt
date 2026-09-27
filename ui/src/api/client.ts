import type { CommandLogEntry } from './gen/CommandLogEntry';
import type { GraphPayload } from './gen/GraphPayload';
import type { RepoSummary } from './gen/RepoSummary';
import { createTransport, type Transport } from './transport';

let transport: Transport | undefined;
const t = () => (transport ??= createTransport(() => { transport = undefined; }));

export const api = {
  openRepo: (path: string) => t().call({ method: 'openRepo', params: { path } }) as Promise<RepoSummary>,
  graph: (repo: number, limit: number | null = null) => t().call({ method: 'graph', params: { repo, limit } }) as Promise<GraphPayload>,
  commandLog: () => t().call({ method: 'commandLog' }) as Promise<CommandLogEntry[]>,
  launchRepo: () => t().call({ method: 'launchRepo' }) as Promise<string | null>,
};

export function errorMessage(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message);
  return String(e);
}
