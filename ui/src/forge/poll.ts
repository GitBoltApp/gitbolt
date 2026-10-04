import { api, errorMessage } from '../api/client';
import type { ForgeMrDetail } from '../api/gen/ForgeMrDetail';
import type { ForgePipeline } from '../api/gen/ForgePipeline';
import type { GbError } from '../api/gen/GbError';
import { useRuntime } from '../app/runtime';
import { useAppState } from '../app/state';
import { clampFetchInterval } from '../settings/schema';
import { openFlyout } from '../ui/flyout/flyout';
import { forgeOf, forgeScratch, keepSame, sameJson, MR_FLYOUT, patchForge, upstreamRefsOf, type MrViewArgs } from './mrStore';
import { backoffMs, type PollOutcome, type PollReason } from './poller';

/** A hover card's detail is asked again once it's this old. */
export const DETAIL_MAX_AGE_MS = 60_000;
const IDLE: PollOutcome = { runningPipeline: false, serverIntervalMs: null };
const isRunning = (p: ForgePipeline | null | undefined) => p?.status === 'running' || p?.status === 'pending';
const repoOf = (tabId: string) => useRuntime.getState().tabs[tabId]?.repo?.id;
const fetchIntervalMs = () => clampFetchInterval(useAppState.getState().settings.fetchIntervalSecs) * 1000;

const touch = (tabId: string, number: number) => forgeScratch.freshAt.set(`${tabId}:${number}`, Date.now());

/** Stores a detail; one that's not modified or equal to the stored one leaves the store as it was. */
function putDetail(tabId: string, number: number, value: ForgeMrDetail, notModified = false): void {
  touch(tabId, number);
  patchForge(tabId, (f) => {
    const have = f.details[number];
    const same = have && (notModified || keepSame(have.value, value) === have.value);
    let detailErrors = f.detailErrors;
    if (number in detailErrors) {
      detailErrors = { ...detailErrors };
      delete detailErrors[number];
    }
    return { details: same ? f.details : { ...f.details, [number]: { value, at: Date.now() } }, detailErrors };
  });
}

const failed = (tabId: string, number: number, e: unknown) => {
  touch(tabId, number);
  patchForge(tabId, (f) => ({ detailErrors: f.detailErrors[number] === errorMessage(e) ? f.detailErrors : { ...f.detailErrors, [number]: errorMessage(e) } }));
};

/**
 * One poll of a tab (spec #4 §3.4; `createForgePoller` decides when):
 * - except `fast`: the repo's target project (asked of the forges again on `activate`), the
 *   badges (`forgeBranchMrs` with the local branches' upstreams);
 * - always: the sidebar section's list, and the MR/PR open in the flyout.
 * A failure keeps what's shown, says so (`error`), and waits: the failure backoff, or until a
 * rate limit's reset, as the outcome's floor.
 */
export async function pollForge(tabId: string, reason: PollReason): Promise<PollOutcome> {
  const repo = repoOf(tabId);
  if (repo === undefined) return IDLE;
  let serverSecs = 0;
  const note = (s: number | null) => {
    if (s !== null && s > serverSecs) serverSecs = s;
  };
  const gone = () => repoOf(tabId) === undefined; // the tab closed while a request ran
  try {
    if (reason !== 'fast' || forgeOf(tabId).kind === null) {
      const projects = await api.forgeRepoProjects(repo, reason === 'activate');
      const target = projects.remotes.find((r) => r.remote === projects.target);
      if (!target?.project || !target.account) {
        patchForge(tabId, { kind: null, remote: null, project: null, byRef: {}, upstreams: {}, list: null, error: null, failures: 0, updatedAt: Date.now() });
        return IDLE;
      }
      if (gone()) return IDLE;
      const host = target.project.host;
      const me = forgeOf(tabId).me ?? (await api.forgeAccounts()).find((a) => a.account.host === host)?.account.user.username ?? null;
      patchForge(tabId, { kind: target.account, remote: target.remote, project: target.project, me });
    }
    if (reason !== 'fast') {
      const { refs, upstreams } = upstreamRefsOf(useRuntime.getState().tabs[tabId]?.sidebar ?? null);
      const badges = await api.forgeBranchMrs(repo, refs);
      if (gone()) return IDLE;
      note(badges.pollIntervalSecs);
      patchForge(tabId, (f) => ({ byRef: keepSame(f.byRef, Object.fromEntries(badges.mrs.map((b) => [b.remoteRef, b.mr]))), upstreams: keepSame(f.upstreams, upstreams) }));
    }
    const list = await api.forgeMrList(repo, forgeOf(tabId).filter);
    if (gone()) return IDLE;
    note(list.pollIntervalSecs);
    patchForge(tabId, (f) => ({ list: f.list && sameJson({ ...f.list, fetchedAt: 0 }, { ...list, fetchedAt: 0 }) ? f.list : list }));
    const open = forgeOf(tabId).openMr;
    // The open MR's own failure is in `detailErrors`; it doesn't fail the badges and the list.
    if (open !== null) await refreshMr(tabId, open).catch(() => {});
    if (gone()) return IDLE;
    patchForge(tabId, { updatedAt: Date.now(), error: null, failures: 0 });
    const f = forgeOf(tabId);
    const runningPipeline = (f.list?.mrs ?? []).some((m) => isRunning(m.pipeline)) || (f.openMr !== null && isRunning(f.details[f.openMr]?.value.mr.pipeline));
    return { runningPipeline, serverIntervalMs: serverSecs > 0 ? serverSecs * 1000 : null };
  } catch (e) {
    const failures = forgeOf(tabId).failures + 1;
    patchForge(tabId, { error: errorMessage(e), failures });
    const d = (e as Partial<GbError> | null)?.detail;
    const limited = d?.kind === 'rateLimited' ? d.until * 1000 - Date.now() : 0;
    return { runningPipeline: false, serverIntervalMs: Math.max(limited, backoffMs(fetchIntervalMs(), failures)) };
  }
}

/** An MR/PR's detail and discussion, now (the view opening, a poll, after a write). A failure is
 * recorded for the view (`detailErrors`) and thrown. */
export async function refreshMr(tabId: string, number: number): Promise<void> {
  const repo = repoOf(tabId);
  if (repo === undefined) return;
  try {
    const [d, t] = await Promise.all([api.forgeMrDetail(repo, number), api.forgeMrDiscussions(repo, number)]);
    if (repoOf(tabId) === undefined) return;
    putDetail(tabId, number, d.value, d.notModified);
    patchForge(tabId, (f) => (number in f.discussions && (t.notModified || sameJson(f.discussions[number], t.value)) ? {} : { discussions: { ...f.discussions, [number]: t.value } }));
  } catch (e) {
    failed(tabId, number, e);
    throw e;
  }
}

/** A hover card's detail: unless one younger than `maxAgeMs` is loaded; one request at a time. */
export function loadMrDetail(tabId: string, number: number, maxAgeMs = DETAIL_MAX_AGE_MS): Promise<void> {
  const key = `${tabId}:${number}`;
  const at = forgeScratch.freshAt.get(key); // a failed load counts too
  if (at !== undefined && Date.now() - at < maxAgeMs) return Promise.resolve();
  const busy = forgeScratch.loading.get(key);
  if (busy) return busy;
  const repo = repoOf(tabId);
  if (repo === undefined) return Promise.resolve();
  const p = api.forgeMrDetail(repo, number).then((d) => { if (repoOf(tabId) !== undefined) putDetail(tabId, number, d.value, d.notModified); }, (e: unknown) => { if (repoOf(tabId) !== undefined) failed(tabId, number, e); }).finally(() => forgeScratch.loading.delete(key));
  forgeScratch.loading.set(key, p);
  return p;
}

/** The MR/PR view (spec #4 §4 "4B"): the tab's flyout, loading the MR/PR at once. */
export function openMrView(tabId: string, number: number): void {
  openFlyout<MrViewArgs>(tabId, MR_FLYOUT, { number });
  patchForge(tabId, { openMr: number });
  void refreshMr(tabId, number).catch(() => {});
}
