import { api } from '../api/client';
import type { ForgeProject } from '../api/gen/ForgeProject';
import { runFetch } from '../app/fetchSchedule';
import { useRuntime } from '../app/runtime';
import { forkCloneUrl, freeRemoteName } from '../forge/remoteUrl';
import { useToast } from '../ui/toastStore';
import { runWrite } from '../write/client';
import { writeCtx } from '../write/ctx';
import { remoteIsProject } from './match';

/** Adds `name` → `url`, says so, then fetches only that remote (spec #4 §4 4A). `true` once
 * added; the fetch reports its own failure (and the remote stays). */
export async function addRemoteAndFetch(tabId: string, name: string, url: string, done = `Added remote ${name}`): Promise<boolean> {
  const ctx = writeCtx(tabId);
  if (!ctx) return false;
  let added = false;
  await runWrite(ctx, () => api.addRemote(ctx.repoId, ctx.worktree, name, url), { onSuccess: () => { added = true; } });
  if (!added) return false;
  useToast.getState().show(done);
  await runFetch(tabId, false, name);
  return true;
}

/** `fork` as a remote named after its owner (`-2`… when taken), reached the way origin is, then
 * fetched: the forks list's Add, and 4B's "Add <owner>'s fork and check out the branch". A
 * remote already on that project is reused. Resolves the remote's name, or `null`. */
export async function addForkRemote(tabId: string, fork: ForgeProject): Promise<string | null> {
  const remotes = useRuntime.getState().tabs[tabId]?.info?.remotes ?? [];
  const existing = remotes.find((r) => remoteIsProject(r, fork.host, fork.path));
  if (existing) return existing.name;
  const owner = fork.owner.split('/').pop() || fork.owner;
  const name = freeRemoteName(owner, remotes.map((r) => r.name));
  const origin = (remotes.find((r) => r.name === 'origin') ?? remotes.find((r) => remoteIsProject(r, fork.host, fork.forkOf)) ?? remotes[0])?.url;
  return (await addRemoteAndFetch(tabId, name, forkCloneUrl(origin, fork), `Added ${owner}'s fork as ${name}`)) ? name : null;
}
