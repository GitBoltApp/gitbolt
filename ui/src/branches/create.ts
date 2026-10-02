import { api } from '../api/client';
import { useRuntime } from '../app/runtime';
import { promptText } from '../ui/PromptDialog';
import { runWrite, type WriteCtx } from '../write/client';
import { branchNameError } from './branchName';

/** The Check out box's last value per source (spec #2 §9.1). */
export const CREATE_KEY = 'gitbolt.branchCreate.v1';
type Source = 'toolbar' | 'menu';
const DEFAULTS: Record<Source, boolean> = { toolbar: true, menu: false };

function remembered(): Record<Source, boolean> {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(CREATE_KEY) ?? '{}') as Partial<Record<Source, boolean>>) };
  } catch {
    return { ...DEFAULTS };
  }
}
function remember(source: Source, checked: boolean): void {
  try {
    localStorage.setItem(CREATE_KEY, JSON.stringify({ ...remembered(), [source]: checked }));
  } catch {
    /* a private window: not remembered */
  }
}

/** A name a local branch already has, from the loaded sidebar. */
const taken = (tabId: string, name: string) => !!useRuntime.getState().tabs[tabId]?.sidebar?.locals.some((b) => b.name === name);

/** The create dialog (§9.1), then the write: a CAS create, the upstream per autoSetupMerge,
 * and a switch when Check out is on. */
export async function createBranchAt(ctx: WriteCtx, start: { sha: string; ref: string | null }, source: Source): Promise<void> {
  const answer = await promptText({
    title: start.ref ? `Create a branch from ${start.ref.replace(/^refs\/(heads|remotes)\//, '')}` : `Create a branch at ${start.sha.slice(0, 7)}`,
    label: 'Branch name',
    confirmLabel: 'Create branch',
    validate: (v) => branchNameError(v) ?? (taken(ctx.tabId, v) ? `A branch named ${v} already exists` : null),
    checkbox: { label: 'Check out', initial: remembered()[source] },
  });
  if (!answer) return;
  remember(source, answer.checked);
  const name = answer.value;
  await runWrite(ctx, (ok) => api.createBranch(ctx.repoId, ctx.worktree, { name, start: start.sha, startRef: start.ref, checkout: answer.checked, expect: { head: null, refs: { [`refs/heads/${name}`]: null } } }, ok));
}
