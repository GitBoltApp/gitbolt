import { api, errorMessage } from '../api/client';
import type { ForgeMr } from '../api/gen/ForgeMr';
import type { ForgeMrDetail } from '../api/gen/ForgeMrDetail';
import type { ForgePipeline } from '../api/gen/ForgePipeline';
import type { GbError } from '../api/gen/GbError';
import type { RateLimitState } from '../api/gen/RateLimitState';
import type { ReviewDiff } from '../api/gen/ReviewDiff';
import { useRuntime } from '../app/runtime';
import { useAppState } from '../app/state';
import { clampFetchInterval } from '../settings/schema';
import { recordPlace } from '../nav/history';
import { sectionKey } from '../sidebar/model';
import { openFlyout, shownFlyout } from '../ui/flyout/flyout';
import { forgeOf, forgeScratch, keepSame, knownMr, sameJson, MR_FLYOUT, patchForge, upstreamRefsOf, writeEpoch, type MrViewArgs, type TabForge } from './mrStore';
import { backoffMs, type PollOutcome, type PollReason } from './poller';
import { mappedRemotes } from './projects';
import { patchReview, settleReview } from './review/lifetime';
import { commentableIndex } from './review/model';

/** A hover card's detail is asked again once it's this old. */
export const DETAIL_MAX_AGE_MS = 60_000;
/** A tab's `activate` polls fully at most this often, whichever poller asks (a tab shown again
 * soon after keeps what it has; its timer and the focus poll as usual). */
export const ACTIVATE_GAP_MS = 30_000;
const IDLE: PollOutcome = { runningPipeline: false, serverIntervalMs: null };
const isRunning = (p: ForgePipeline | null | undefined) => p?.status === 'running';
/** A pipeline runs, or the forge is merging it (GitLab's `locked`, moments): worth a fast poll. */
const hurried = (m: ForgeMr) => isRunning(m.pipeline) || m.state === 'merging';
const repoOf = (tabId: string) => useRuntime.getState().tabs[tabId]?.repo?.id;
const fetchIntervalMs = () => clampFetchInterval(useAppState.getState().settings.fetchIntervalSecs) * 1000;

const touch = (tabId: string, number: number) => forgeScratch.freshAt.set(`${tabId}:${number}`, Date.now());

/** The visible MRs/PRs whose pipeline runs (spec #4 §3.4's fast poll): the open MR/PR's, and the
 * list's while the sidebar's MR/PR section is expanded (`listShown`), as `<number>:<head>`. A
 * pending one doesn't count. */
export function runningShown(f: TabForge, listShown: boolean): string[] {
  const out = new Set<string>();
  const open = f.openMr === null ? null : f.details[f.openMr]?.value.mr ?? knownMr(f, f.openMr);
  if (open && hurried(open)) out.add(`${open.number}:${open.headSha ?? ''}`);
  if (listShown) for (const m of f.list?.mrs ?? []) if (hurried(m)) out.add(`${m.number}:${m.headSha ?? ''}`);
  return [...out].sort();
}

/** A visible MR/PR's pipeline runs (`runningShown`). */
export function fastPollWanted(f: TabForge, listShown: boolean): boolean {
  return runningShown(f, listShown).length > 0;
}

/** Requests one poll costs, about (the badges' and the list's, the open MR/PR's): what a low
 * rate-limit budget is spread over. */
export const POLL_COST = 3;
/** Under this share of its budget left, the poll slows so the rest lasts until the reset. */
export const LOW_BUDGET = 0.1;

/** What the account's rate limit asks of the next poll (ms epoch `now`): `floorMs`, the least
 * wait; `limitedUntil`, set when nothing may be asked before then (the budget is spent). Under
 * LOW_BUDGET of the budget, the polls left (`remaining / POLL_COST`) are spread until the reset. */
export function ratePacing(rl: RateLimitState | null | undefined, now: number): { floorMs: number; limitedUntil: number | null } {
  if (!rl) return { floorMs: 0, limitedUntil: null };
  const until = rl.limitedUntil !== null ? rl.limitedUntil * 1000 : null;
  if (until !== null && until > now) return { floorMs: until - now, limitedUntil: until };
  const { remaining, limit, resetAt } = rl;
  if (remaining === null || !limit || resetAt === null || remaining >= limit * LOW_BUDGET) return { floorMs: 0, limitedUntil: null };
  const left = resetAt * 1000 - now;
  if (left <= 0) return { floorMs: 0, limitedUntil: null };
  if (remaining === 0) return { floorMs: left, limitedUntil: resetAt * 1000 };
  return { floorMs: Math.ceil((left * POLL_COST) / remaining), limitedUntil: null };
}

/** The tab's MR/PR section is expanded (the repository's collapsed panels). */
function mrSectionShown(tabId: string): boolean {
  const path = useRuntime.getState().tabs[tabId]?.repo?.path;
  const collapsed = path === undefined ? undefined : useAppState.getState().profile.repos[path]?.collapsed;
  return !(collapsed ?? []).includes(sectionKey('mrs'));
}

function outcome(tabId: string, serverIntervalMs: number | null): PollOutcome {
  const running = runningShown(forgeOf(tabId), mrSectionShown(tabId));
  return running.length > 0 ? { runningPipeline: true, serverIntervalMs, pipelineKey: running.join(' ') } : { runningPipeline: false, serverIntervalMs };
}

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
 * - always: the sidebar section's list, and the MR/PR open in the flyout;
 * - except `fast`: the tab's review session (its MR and drafts, `refreshReview`).
 * Each part fails alone: badges that couldn't refresh keep theirs and say so, and the list is
 * still asked. A failure keeps what's shown, says so (`error`), and waits: the failure backoff,
 * or until a rate limit's reset, as the outcome's floor. A low rate-limit budget slows the next
 * poll (`ratePacing`), and a spent one waits for its reset ("Rate limited until …").
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
  // A tab with nothing yet shows what the last session left at once (no request), marked stale.
  if (forgeOf(tabId).updatedAt === null && forgeOf(tabId).list === null) await showCached(tabId, repo);
  try {
    if (reason !== 'fast' || forgeOf(tabId).kind === null) {
      const projects = await api.forgeRepoProjects(repo, reason === 'activate' || forgeScratch.recheck.delete(tabId));
      const target = projects.remotes.find((r) => r.remote === projects.target);
      const remoteErrors = Object.fromEntries(projects.remotes.flatMap((r) => (r.error ? [[r.remote, r.error]] : [])));
      // Every remote whose project has an owner picture (a user's, an organization's or a group's, the target's too) shows it on its icons.
      const ownerAvatars = Object.fromEntries(projects.remotes.flatMap((r) => (r.project?.ownerAvatarUrl ? [[r.remote, r.project.ownerAvatarUrl]] : [])));
      patchForge(tabId, (f) => ({ target: projects.target, targetChosen: projects.targetChosen, remoteErrors: keepSame(f.remoteErrors, remoteErrors), ownerAvatars: keepSame(f.ownerAvatars, ownerAvatars) }));
      if (target && !target.project && target.account && target.error) {
        // The target (the user's choice, or origin) is on a forge but its project can't be loaded: say why, don't hide the section or show another remote.
        patchForge(tabId, { kind: target.account, remote: target.remote, project: null, mapped: [], byRef: {}, history: {}, upstreams: {}, list: null, error: `${target.path ?? target.remote}: ${target.error}`, failures: forgeOf(tabId).failures + 1, updatedAt: Date.now() });
        return { runningPipeline: false, serverIntervalMs: backoffMs(fetchIntervalMs(), forgeOf(tabId).failures) };
      }
      if (!target?.project || !target.account) {
        patchForge(tabId, { kind: null, remote: null, project: null, mapped: [], byRef: {}, history: {}, upstreams: {}, list: null, error: null, failures: 0, updatedAt: Date.now() });
        return IDLE;
      }
      if (gone()) return IDLE;
      const host = target.project.host;
      const me = forgeOf(tabId).me ?? (await api.forgeAccounts()).find((a) => a.account.host === host)?.account.user.username ?? null;
      patchForge(tabId, (f) => ({ kind: target.account, remote: target.remote, project: target.project, mapped: keepSame(f.mapped, mappedRemotes(projects, host)), me }));
    }
    // The badges failing (one slow request) costs only the badges: the list is still asked.
    let partial: unknown = null;
    if (reason !== 'fast') {
      const { refs, upstreams } = upstreamRefsOf(useRuntime.getState().tabs[tabId]?.sidebar ?? null, forgeOf(tabId));
      try {
        const badges = await api.forgeBranchMrs(repo, refs);
        if (gone()) return IDLE;
        note(badges.pollIntervalSecs);
        if (current()) {
          patchForge(tabId, (f) => ({
            byRef: keepSame(f.byRef, Object.fromEntries(badges.mrs.map((b) => [b.remoteRef, b.mr]))),
            history: keepSame(f.history, Object.fromEntries(badges.history.map((b) => [b.remoteRef, b.mr]))),
            upstreams: keepSame(f.upstreams, upstreams),
          }));
        }
      } catch (e) {
        if (gone()) return IDLE;
        partial = e;
      }
    }
    const filter = forgeOf(tabId).filter;
    const list = await api.forgeMrList(repo, filter);
    if (gone()) return IDLE;
    note(list.pollIntervalSecs);
    // A filter chosen meanwhile has its own list coming (`refreshMrList`).
    if (current() && forgeOf(tabId).filter === filter) patchForge(tabId, (f) => ({ list: f.list && sameJson({ ...f.list, fetchedAt: 0, rateLimit: undefined }, { ...list, fetchedAt: 0, rateLimit: undefined }) ? f.list : list }));
    const open = forgeOf(tabId).openMr;
    // The open MR's own failure is in `detailErrors`; it doesn't fail the badges and the list.
    if (open !== null) await refreshMr(tabId, open).catch(() => {});
    // The tab's review session: its MR's threads (when it isn't the one open), then its drafts.
    // Not on a fast poll (a running pipeline's): POLL_COST paces those without them.
    const reviewing = reason === 'fast' ? undefined : forgeOf(tabId).review?.number;
    if (reviewing !== undefined && reviewing !== open) await refreshMr(tabId, reviewing).catch(() => {});
    if (reviewing !== undefined) await refreshReview(tabId);
    if (gone()) return IDLE;
    const pace = ratePacing(list.rateLimit, Date.now());
    if (partial !== null) {
      // The list is fresh; the badges say why they aren't. No backoff: the next poll asks them.
      patchForge(tabId, { updatedAt: Date.now(), error: errorMessage(partial), limitedUntil: pace.limitedUntil, cachedAt: null });
      return { ...outcome(tabId, Math.max(serverSecs * 1000, pace.floorMs) || null), failed: true };
    }
    patchForge(tabId, { updatedAt: Date.now(), error: null, failures: 0, limitedUntil: pace.limitedUntil, cachedAt: null });
    return outcome(tabId, Math.max(serverSecs * 1000, pace.floorMs) || null);
  } catch (e) {
    const failures = forgeOf(tabId).failures + 1;
    const d = (e as Partial<GbError> | null)?.detail;
    const until = d?.kind === 'rateLimited' ? d.until * 1000 : null;
    patchForge(tabId, { error: errorMessage(e), failures, limitedUntil: until !== null && until > Date.now() ? until : forgeOf(tabId).limitedUntil });
    const limited = until !== null ? until - Date.now() : 0;
    return { runningPipeline: false, serverIntervalMs: Math.max(limited, backoffMs(fetchIntervalMs(), failures)), failed: true };
  }
}

/** The last session's list and badges for a tab that has nothing yet (`forgeCachedMrs`: no
 * request), shown as they were read ("Updated 2 hours ago") until the poll answers. Best effort. */
async function showCached(tabId: string, repo: number): Promise<void> {
  const f = forgeOf(tabId);
  const { refs, upstreams } = upstreamRefsOf(useRuntime.getState().tabs[tabId]?.sidebar ?? null, f);
  let cached: Awaited<ReturnType<typeof api.forgeCachedMrs>> = null;
  try {
    cached = await api.forgeCachedMrs(repo, refs, f.filter);
  } catch {
    return;
  }
  if (!cached || repoOf(tabId) === undefined) return;
  patchForge(tabId, (now) => {
    // A poll answered meanwhile: what it said is newer.
    if (now.updatedAt !== null) return {};
    const at = cached.savedAt * 1000;
    return {
      kind: cached.kind, remote: cached.remote, project: cached.project,
      list: now.filter === f.filter ? cached.list : now.list,
      byRef: cached.badges ? Object.fromEntries(cached.badges.mrs.map((b) => [b.remoteRef, b.mr])) : now.byRef,
      history: cached.badges ? Object.fromEntries(cached.badges.history.map((b) => [b.remoteRef, b.mr])) : now.history,
      upstreams: cached.badges ? upstreams : now.upstreams,
      updatedAt: at, cachedAt: at,
    };
  });
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

/** The tab's review session, now (spec §1 "Refreshes"): the user's drafts every time, the diff's
 * refs and commentable lines once per set of refs (the author pushed, or the target branch
 * changed: read again). Never throws: a
 * failure is the session's `error`, what's shown stays (a diff that fails keeps the last refs and
 * lines; the drafts read still counts). An answer that may predate a write's is dropped. Then the
 * session is settled (`settleReview`). */
export async function refreshReview(tabId: string): Promise<void> {
  const repo = repoOf(tabId);
  const s = forgeOf(tabId).review;
  if (repo === undefined || !s) return;
  const epoch = writeEpoch(tabId);
  try {
    const state = await api.forgeReviewDrafts(repo, s.number);
    const asked = state.refs && `${s.number} ${state.refs.baseSha} ${state.refs.startSha} ${state.refs.headSha}`;
    let diff: ReviewDiff | null = null;
    let diffError: string | null = null;
    if (asked && asked !== forgeScratch.reviewRefs.get(tabId)) {
      try {
        diff = await api.forgeReviewDiff(repo, s.number);
      } catch (e) {
        diffError = errorMessage(e);
      }
    }
    if (repoOf(tabId) === undefined || writeEpoch(tabId) !== epoch) return;
    if (diff && asked && forgeOf(tabId).review?.number === s.number) forgeScratch.reviewRefs.set(tabId, asked);
    patchReview(tabId, s.number, (cur) => ({
      drafts: keepSame(cur.drafts, state.drafts), pendingReview: state.pendingReview, canDraft: state.canDraft, error: diffError, loaded: true,
      ...(diff && { refs: keepSame(cur.refs, diff.refs), files: Object.fromEntries(diff.files.map((f) => [f.path, commentableIndex(f)])), diffHead: diff.refs.headSha }),
    }));
  } catch (e) {
    patchReview(tabId, s.number, () => ({ error: errorMessage(e) }));
  }
  settleReview(tabId);
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

/** The MR/PR view (spec #4 §4 "4B"): the tab's flyout. The view loads the MR/PR as it mounts.
 * Spec #5 §3.4: a navigation place, recorded first (the view being left saves its scroll);
 * `replace` (the sidebar list's arrow keys) swaps the current MR/PR place instead of adding one. */
export function openMrView(tabId: string, number: number, how: 'push' | 'replace' = 'push'): void {
  // Already open on this MR: keep it as it is (opening it again would remount the view and load
  // its commits and threads again).
  const shown = shownFlyout(tabId);
  if (shown?.kind === MR_FLYOUT && (shown.props as MrViewArgs).number === number) return;
  recordPlace(tabId, { kind: 'mr', number, scrollTop: 0 }, how);
  openFlyout<MrViewArgs>(tabId, MR_FLYOUT, { number });
  patchForge(tabId, { openMr: number });
}
