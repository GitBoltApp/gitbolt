import { api, errorMessage } from '../api/client';
import type { ForgeMrDetail } from '../api/gen/ForgeMrDetail';
import type { ForgePipeline } from '../api/gen/ForgePipeline';
import type { GbError } from '../api/gen/GbError';
import { useRuntime } from '../app/runtime';
import { useAppState } from '../app/state';
import { clampFetchInterval } from '../settings/schema';
import { sectionKey } from '../sidebar/model';
import { openFlyout } from '../ui/flyout/flyout';
import { forgeOf, forgeScratch, keepSame, knownMr, sameJson, MR_FLYOUT, patchForge, upstreamRefsOf, writeEpoch, type MrViewArgs, type TabForge } from './mrStore';
import { backoffMs, type PollOutcome, type PollReason } from './poller';

/** A hover card's detail is asked again once it's this old. */
export const DETAIL_MAX_AGE_MS = 60_000;
/** A tab's `activate` polls fully at most this often, whichever poller asks (a tab shown again
 * soon after keeps what it has; its timer and the focus poll as usual). */
export const ACTIVATE_GAP_MS = 30_000;
const IDLE: PollOutcome = { runningPipeline: false, serverIntervalMs: null };
const isRunning = (p: ForgePipeline | null | undefined) => p?.status === 'running';
const repoOf = (tabId: string) => useRuntime.getState().tabs[tabId]?.repo?.id;
const fetchIntervalMs = () => clampFetchInterval(useAppState.getState().settings.fetchIntervalSecs) * 1000;

const touch = (tabId: string, number: number) => forgeScratch.freshAt.set(`${tabId}:${number}`, Date.now());

/** A visible MR/PR's pipeline runs (spec #4 §3.4's ~20 s poll): the open MR/PR's, and the list's
 * while the sidebar's MR/PR section is expanded (`listShown`). A pending one doesn't count. */
export function fastPollWanted(f: TabForge, listShown: boolean): boolean {
  if (f.openMr !== null && isRunning((f.details[f.openMr]?.value.mr ?? knownMr(f, f.openMr))?.pipeline)) return true;
  return listShown && (f.list?.mrs ?? []).some((m) => isRunning(m.pipeline));
}

/** The tab's MR/PR section is expanded (the repository's collapsed panels). */
function mrSectionShown(tabId: string): boolean {
  const path = useRuntime.getState().tabs[tabId]?.repo?.path;
  const collapsed = path === undefined ? undefined : useAppState.getState().profile.repos[path]?.collapsed;
  return !(collapsed ?? []).includes(sectionKey('mrs'));
}

const outcome = (tabId: string, serverIntervalMs: number | null): PollOutcome => ({ runningPipeline: fastPollWanted(forgeOf(tabId), mrSectionShown(tabId)), serverIntervalMs });

/** Stores a detail; one equal to the stored one leaves the store as it was. (Not by
 * `notModified`: a composite's other parts may change while its first request answers 304.) */
function putDetail(tabId: string, number: number, value: ForgeMrDetail): void {
  touch(tabId, number);
  patchForge(tabId, (f) => {
    const have = f.details[number];
    const same = have && keepSame(have.value, value) === have.value;
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

/** The tab's poll in flight, whichever poller started it. */
const polling = new Map<string, Promise<PollOutcome>>();

/**
 * One poll of a tab (spec #4 §3.4; `createForgePoller` decides when):
 * - except `fast`: the repo's target project (asked of the forges again on `activate`), the
 *   badges (`forgeBranchMrs` with the local branches' upstreams);
 * - always: the sidebar section's list, and the MR/PR open in the flyout.
 * A failure keeps what's shown, says so (`error`), and waits: the failure backoff, or until a
 * rate limit's reset, as the outcome's floor.
 * One poll per tab at a time: a call while one runs joins it (a new poller after a quick tab
 * switch), except a `write`, which runs after it. An `activate` within ACTIVATE_GAP_MS of the
 * last full one asks nothing (unless the last poll failed). An answer to a request that started
 * before a GitBolt write's answer (`writeEpoch`) is dropped: it may predate the write.
 */
export function pollForge(tabId: string, reason: PollReason): Promise<PollOutcome> {
  const busy = polling.get(tabId);
  if (busy) return reason === 'write' ? busy.then(() => pollForge(tabId, reason), () => pollForge(tabId, reason)) : busy;
  const p: Promise<PollOutcome> = pollOnce(tabId, reason).finally(() => {
    if (polling.get(tabId) === p) polling.delete(tabId);
  });
  polling.set(tabId, p);
  return p;
}

async function pollOnce(tabId: string, reason: PollReason): Promise<PollOutcome> {
  const repo = repoOf(tabId);
  if (repo === undefined) return IDLE;
  if (reason === 'activate') {
    const at = forgeScratch.activatedAt.get(tabId);
    if (at !== undefined && Date.now() - at < ACTIVATE_GAP_MS && forgeOf(tabId).error === null) return outcome(tabId, null);
    forgeScratch.activatedAt.set(tabId, Date.now());
  }
  const epoch = writeEpoch(tabId);
  const current = () => writeEpoch(tabId) === epoch;
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
      if (current()) patchForge(tabId, (f) => ({ byRef: keepSame(f.byRef, Object.fromEntries(badges.mrs.map((b) => [b.remoteRef, b.mr]))), upstreams: keepSame(f.upstreams, upstreams) }));
    }
    const filter = forgeOf(tabId).filter;
    const list = await api.forgeMrList(repo, filter);
    if (gone()) return IDLE;
    note(list.pollIntervalSecs);
    // A filter chosen meanwhile has its own list coming (`refreshMrList`).
    if (current() && forgeOf(tabId).filter === filter) patchForge(tabId, (f) => ({ list: f.list && sameJson({ ...f.list, fetchedAt: 0 }, { ...list, fetchedAt: 0 }) ? f.list : list }));
    const open = forgeOf(tabId).openMr;
    // The open MR's own failure is in `detailErrors`; it doesn't fail the badges and the list.
    if (open !== null) await refreshMr(tabId, open).catch(() => {});
    if (gone()) return IDLE;
    patchForge(tabId, { updatedAt: Date.now(), error: null, failures: 0 });
    return outcome(tabId, serverSecs > 0 ? serverSecs * 1000 : null);
  } catch (e) {
    const failures = forgeOf(tabId).failures + 1;
    patchForge(tabId, { error: errorMessage(e), failures });
    const d = (e as Partial<GbError> | null)?.detail;
    const limited = d?.kind === 'rateLimited' ? d.until * 1000 - Date.now() : 0;
    return { runningPipeline: false, serverIntervalMs: Math.max(limited, backoffMs(fetchIntervalMs(), failures)) };
  }
}

/** An MR/PR's detail and discussion, now (the view opening, a poll). A failure is recorded for
 * the view (`detailErrors`) and thrown. An answer that may predate a write's is dropped. */
export async function refreshMr(tabId: string, number: number): Promise<void> {
  const repo = repoOf(tabId);
  if (repo === undefined) return;
  const epoch = writeEpoch(tabId);
  try {
    const [d, t] = await Promise.all([api.forgeMrDetail(repo, number), api.forgeMrDiscussions(repo, number)]);
    if (repoOf(tabId) === undefined || writeEpoch(tabId) !== epoch) return;
    putDetail(tabId, number, d.value);
    patchForge(tabId, (f) => (number in f.discussions && sameJson(f.discussions[number], t.value) ? {} : { discussions: { ...f.discussions, [number]: t.value } }));
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
  const epoch = writeEpoch(tabId);
  const p = api.forgeMrDetail(repo, number).then((d) => { if (repoOf(tabId) !== undefined && writeEpoch(tabId) === epoch) putDetail(tabId, number, d.value); }, (e: unknown) => { if (repoOf(tabId) !== undefined) failed(tabId, number, e); }).finally(() => forgeScratch.loading.delete(key));
  forgeScratch.loading.set(key, p);
  return p;
}

/** The MR/PR view (spec #4 §4 "4B"): the tab's flyout. The view loads the MR/PR as it mounts. */
export function openMrView(tabId: string, number: number): void {
  openFlyout<MrViewArgs>(tabId, MR_FLYOUT, { number });
  patchForge(tabId, { openMr: number });
}
