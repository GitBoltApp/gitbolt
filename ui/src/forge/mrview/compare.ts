import { api } from '../../api/client';
import type { ForgeKind } from '../../api/gen/ForgeKind';
import type { ForgeMr } from '../../api/gen/ForgeMr';
import type { ForgeMrDetail } from '../../api/gen/ForgeMrDetail';
import type { MrHead } from '../../api/gen/MrHead';
import { runFetch } from '../../app/fetchSchedule';
import { useRuntime } from '../../app/runtime';
import { tabStore } from '../../app/tabStores';
import { shortSha } from '../../format/sha';
import type { RepoViewStore } from '../../repo/store';
import { useToast } from '../../ui/toastStore';
import { mrName } from '../labels';
import { forgeOf } from '../mrStore';
import { refreshReview } from '../poll';
import { startReview } from '../review/session';
import { preloadReviewMode } from '../../diff/review/ReviewMode';

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
 * Puts `sha` in the graph (`loadInGraph`); one the repository doesn't have is fetched from
 * `remote` first: `mrHead`, that MR/PR's head ref alone, else the remote's branches.
 */
async function reach(tabId: string, repo: number, store: RepoViewStore, sha: string, remote: string | null, mrHead?: MrHead): Promise<boolean> {
  if ((await loadInGraph(tabId, repo, store, [sha])) === 'ok') return true;
  if (!remote) return false;
  await (mrHead ? runFetch(tabId, false, remote, mrHead) : runFetch(tabId, false, remote));
  await useRuntime.getState().refresh(tabId);
  return (await loadInGraph(tabId, repo, store, [sha])) === 'ok';
}

/**
 * The branch card's Compare: the MR/PR's changes as a compare in the graph, exactly as clicking
 * its base then Ctrl+clicking its head (`compareCommits`), which opens the compare's files. The
 * base is the merge base of the forge's (GitLab's `diff_refs.base_sha`, GitHub's `base.sha`; else
 * the target's remote tip) and the head, so the diff matches the forge's Changes. A head or base
 * that's in the repository but older than the loaded window loads a deeper one, with no network;
 * only a head that isn't in the repository is fetched: its ref alone (`refs/merge-requests/<n>/head`,
 * `refs/pull/<n>/head`), from the target's remote, into a ref a pruning fetch keeps.
 *
 * A merged one fetches no ref of its own: it compares the commit it landed as (`mergedSha`) with
 * that commit's first parent, or its head when the forge names none (fast-forwarded); a commit
 * the repository lacks is fetched with the remote's branches, and said missing if still not there.
 * True when the compare is shown.
 */
export async function compareMr(tabId: string, kind: ForgeKind, mr: ForgeMr, detail: ForgeMrDetail | null): Promise<boolean> {
  const say = (m: string): false => { useToast.getState().show(m); return false; };
  const noun = mrName(kind).toLowerCase();
  // The tab's review of this MR: its diff refs, read again now, are the forge's own for its
  // positions, and can be newer than the cached detail. Compared there, the Compare is the
  // review's (Compare again lands on the head the forge reports, not on the stale one again).
  if (forgeOf(tabId).review?.number === mr.number) await refreshReview(tabId);
  const f = forgeOf(tabId);
  const refs = f.review?.number === mr.number ? f.review.refs : null;
  const head = refs?.headSha ?? detail?.mr.headSha ?? mr.headSha;
  const merged = (detail?.mr.state ?? mr.state) === 'merged';
  const landed = merged ? (detail?.mergedSha ?? null) : null;
  const repo = useRuntime.getState().tabs[tabId]?.repo?.id;
  const store = tabStore(tabId);
  const remote = f.remote;
  if (repo !== undefined && store && landed) return compareLanded(tabId, repo, store, landed, remote, noun, say);
  if (repo === undefined || !store || !head) return say(`The ${noun}'s head isn't known yet`);
  if (!(await reach(tabId, repo, store, head, remote, merged ? undefined : { kind, number: mr.number }))) {
    if (!remote) return say(`The ${noun}'s commits aren't in this repository`);
    return say(merged ? `The merged ${noun}'s commits aren't on ${remote}` : `The ${noun}'s commits couldn't be fetched from ${remote}`);
  }
  const rt = useRuntime.getState().tabs[tabId];
  const tip = remote ? rt?.sidebar?.remotes.find((g) => g.name === remote)?.branches.find((b) => b.name === mr.targetBranch)?.target : undefined;
  // The forge's base may not be fetched (GitHub's is the target's tip when the PR last changed).
  let base: string | null = null;
  for (const from of [refs?.baseSha, detail?.baseSha, tip]) {
    if (from && !base) base = await api.mergeBase(repo, from, head).catch(() => null);
  }
  if (!base) return say(`The ${noun}'s base isn't in this repository: fetch first`);
  if ((await loadInGraph(tabId, repo, store, [base, head])) === 'missing' || !store.getState().compareCommits(base, head)) return say(`The ${noun}'s base isn't in the graph's history`);
  // Spec 2026-10-08 §1: the MR's Compare is where its review happens.
  void startReview(tabId, kind, mr.number, { from: base, to: head });
  // Its cards' code, so the first file opened in it doesn't wait for it.
  preloadReviewMode().catch(() => {});
  return true;
}

/** A merged MR's Compare: the commit it landed as on its target (a merge or squash commit) with
 * its first parent, the MR's changes as they went in. No review starts: a merged MR's ends. */
async function compareLanded(tabId: string, repo: number, store: RepoViewStore, landed: string, remote: string | null, noun: string, say: (m: string) => false): Promise<boolean> {
  if (!(await reach(tabId, repo, store, landed, remote))) return say(`The ${noun} was merged as ${shortSha(landed)}, which isn't ${remote ? `on ${remote}` : 'in this repository'}`);
  const s = store.getState();
  const parent = s.graph.rows[s.indexById.get(landed) ?? -1]?.parents[0];
  if (!parent) return say(`${shortSha(landed)}, the ${noun}'s merge, has no parent to compare with`);
  if ((await loadInGraph(tabId, repo, store, [parent, landed])) === 'missing' || !store.getState().compareCommits(parent, landed)) return say(`The ${noun}'s merge isn't in the graph's history`);
  return true;
}
