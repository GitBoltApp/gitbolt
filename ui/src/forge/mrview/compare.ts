import { api } from '../../api/client';
import type { ForgeKind } from '../../api/gen/ForgeKind';
import type { ForgeMr } from '../../api/gen/ForgeMr';
import type { ForgeMrDetail } from '../../api/gen/ForgeMrDetail';
import { runFetch } from '../../app/fetchSchedule';
import { useRuntime } from '../../app/runtime';
import { tabStore } from '../../app/tabStores';
import type { RepoViewStore } from '../../repo/store';
import { useToast } from '../../ui/toastStore';
import { mrName } from '../labels';
import { forgeOf } from '../mrStore';

/** How long Compare waits for the graph to show a just-fetched head. */
export const GRAPH_WAIT_MS = 5000;

/** Resolves once `sha` is among the graph's loaded rows (true), or after `ms` (false). */
function inGraphSoon(store: RepoViewStore, sha: string, ms: number): Promise<boolean> {
  if (store.getState().indexById.has(sha)) return Promise.resolve(true);
  return new Promise((done) => {
    const t = setTimeout(() => { stop(); done(false); }, ms);
    const stop = store.subscribe((s) => {
      if (!s.indexById.has(sha)) return;
      clearTimeout(t);
      stop();
      done(true);
    });
  });
}

/**
 * Makes the graph hold `shas` without the network: a commit that's in the repository but older
 * than the loaded window gets a deeper window (as Find's "Search older history"). `missing`: one
 * isn't in the repository, or isn't reachable from the graph's refs (a fetch may bring it).
 */
async function loadInGraph(tabId: string, repo: number, store: RepoViewStore, shas: string[]): Promise<'ok' | 'missing'> {
  const out = shas.filter((sha) => !store.getState().indexById.has(sha));
  if (!out.length) return 'ok';
  let limit = 0;
  for (const sha of out) {
    const loc = await api.locateCommit(repo, sha).catch(() => null);
    if (!loc?.found) return 'missing';
    limit = Math.max(limit, loc.limit ?? 0);
  }
  const rt = useRuntime.getState();
  if (limit > (rt.tabs[tabId]?.limit ?? 0)) {
    rt.patch(tabId, { limit });
    await rt.refresh(tabId);
  }
  for (const sha of out) if (!(await inGraphSoon(store, sha, GRAPH_WAIT_MS))) return 'missing';
  return 'ok';
}

/**
 * The branch card's Compare: the MR/PR's changes as a compare in the graph, exactly as clicking
 * its base then Ctrl+clicking its head (`compareCommits`), which opens the compare's files. The
 * base is the merge base of the forge's (GitLab's `diff_refs.base_sha`, GitHub's `base.sha`; else
 * the target's remote tip) and the head, so the diff matches the forge's Changes. A head or base
 * that's in the repository but older than the loaded window loads a deeper one, with no network;
 * only a head that isn't in the repository is fetched: its ref alone (`refs/merge-requests/<n>/head`,
 * `refs/pull/<n>/head`), from the target's remote. True when the compare is shown.
 */
export async function compareMr(tabId: string, kind: ForgeKind, mr: ForgeMr, detail: ForgeMrDetail | null): Promise<boolean> {
  const say = (m: string) => { useToast.getState().show(m); return false; };
  const noun = mrName(kind).toLowerCase();
  const head = detail?.mr.headSha ?? mr.headSha;
  const repo = useRuntime.getState().tabs[tabId]?.repo?.id;
  const store = tabStore(tabId);
  const remote = forgeOf(tabId).remote;
  if (repo === undefined || !store || !head) return say(`The ${noun}'s head isn't known yet`);
  if ((await loadInGraph(tabId, repo, store, [head])) === 'missing') {
    if (!remote) return say(`The ${noun}'s commits aren't in this repository`);
    await runFetch(tabId, false, remote, { kind, number: mr.number });
    await useRuntime.getState().refresh(tabId);
    if ((await loadInGraph(tabId, repo, store, [head])) === 'missing') return say(`The ${noun}'s commits couldn't be fetched from ${remote}`);
  }
  const rt = useRuntime.getState().tabs[tabId];
  const tip = remote ? rt?.sidebar?.remotes.find((g) => g.name === remote)?.branches.find((b) => b.name === mr.targetBranch)?.target : undefined;
  // The forge's base may not be fetched (GitHub's is the target's tip when the PR last changed).
  let base: string | null = null;
  for (const from of [detail?.baseSha, tip]) {
    if (from && !base) base = await api.mergeBase(repo, from, head).catch(() => null);
  }
  if (!base) return say(`The ${noun}'s base isn't in this repository: fetch first`);
  if ((await loadInGraph(tabId, repo, store, [base, head])) === 'missing' || !store.getState().compareCommits(base, head)) return say(`The ${noun}'s base isn't in the graph's history`);
  return true;
}
