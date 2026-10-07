import { api, errorMessage } from '../../api/client';
import type { ForgeKind } from '../../api/gen/ForgeKind';
import type { ForgeMr } from '../../api/gen/ForgeMr';
import type { ForgeUser } from '../../api/gen/ForgeUser';
import type { GbError } from '../../api/gen/GbError';
import type { MrEdit } from '../../api/gen/MrEdit';
import { mrRef } from '../labels';
import { useRuntime } from '../../app/runtime';
import { useToast } from '../../ui/toastStore';
import { forgeOf, noteForgeWritten, patchForge } from '../mrStore';
import { learnLimit, type PeopleRole } from '../peopleLimits';
import { notifyForgeWrite } from '../usePolling';

/**
 * One forge write from the MR/PR view (spec #4 §3.5: a remote action, not journaled). It works:
 * the tab's poller polls at once, and the caller puts the answer in the store. It fails: a toast
 * says why, and nothing in the store changes (§6: no optimistic UI).
 */
export async function forgeWrite<T>(tabId: string, failure: string, send: (repo: number) => Promise<T>): Promise<{ value: T } | null> {
  const repo = useRuntime.getState().tabs[tabId]?.repo?.id;
  if (repo === undefined) return null;
  try {
    const value = await send(repo);
    noteForgeWritten(tabId); // a poll or load already under way may predate this answer
    notifyForgeWrite(tabId);
    return { value };
  } catch (e) {
    // MR round 2: the forge kept only one person: the message alone ("GitLab kept only Ada:
    // this project allows one reviewer"), and the row swaps from now on.
    const detail = (e as GbError | null)?.detail;
    if (detail?.kind === 'peopleLimit') {
      const remote = forgeOf(tabId).remote;
      if (remote) learnLimit(repo, remote, detail.role === 'reviewers' ? 'reviewers' : 'assignees');
      useToast.getState().show(errorMessage(e), { error: true });
      return null;
    }
    useToast.getState().show(`${failure}: ${errorMessage(e)}`, { error: true });
    return null;
  }
}

/** The MR/PR a write answered with, into the list and its detail. A write's answer has no review
 * (and GitLab's no pipeline): the loaded ones stay until the next poll. */
export function putMr(tabId: string, mr: ForgeMr): void {
  patchForge(tabId, (f) => {
    const list = f.list ? { ...f.list, mrs: f.list.mrs.map((m) => (m.number === mr.number ? { ...mr, review: m.review, pipeline: mr.pipeline ?? m.pipeline } : m)) } : null;
    const d = f.details[mr.number];
    if (!d) return { list };
    const merged = { ...mr, review: d.value.mr.review, pipeline: mr.pipeline ?? d.value.mr.pipeline };
    return { list, details: { ...f.details, [mr.number]: { value: { ...d.value, mr: merged }, at: d.at } } };
  });
}

/** Draft ⇄ ready (the MR view's ⋯ menu, the sidebar row's menu): a toast as it starts, the
 * answer into the store, and the poll `forgeWrite` asks for. True when it worked. */
export async function toggleMrDraft(tabId: string, kind: ForgeKind, mr: ForgeMr): Promise<boolean> {
  const draft = mr.state !== 'draft';
  const ref = mrRef(kind, mr.number);
  useToast.getState().show(draft ? `Marking ${ref} as a draft…` : `Marking ${ref} as ready…`);
  const out = await forgeWrite(tabId, draft ? `Couldn't mark ${ref} as a draft` : `Couldn't mark ${ref} as ready`, (repo) => api.forgeSetDraft(repo, mr.number, draft));
  if (out) putMr(tabId, out.value);
  return out !== null;
}

/** The ⋮ menu's Subscribe / Unsubscribe: shown at once, then sent; a refusal puts it back and a
 * toast says why. True when it worked. */
export async function setMrSubscribed(tabId: string, kind: ForgeKind, number: number, on: boolean): Promise<boolean> {
  const put = (subscribed: boolean) => patchForge(tabId, (f) => {
    const d = f.details[number];
    return d ? { details: { ...f.details, [number]: { value: { ...d.value, subscribed }, at: d.at } } } : {};
  });
  put(on);
  const ref = mrRef(kind, number);
  const out = await forgeWrite(tabId, on ? `Couldn't subscribe to ${ref}` : `Couldn't unsubscribe from ${ref}`, (repo) => api.forgeSetSubscribed(repo, number, on));
  put(out ? out.value : !on);
  return out !== null;
}

export function putDescription(tabId: string, number: number, description: string): void {
  patchForge(tabId, (f) => {
    const d = f.details[number];
    return d ? { details: { ...f.details, [number]: { value: { ...d.value, description }, at: d.at } } } : {};
  });
}

export type { PeopleRole };

/** Each MR's people changes, one after the other: GitLab takes the whole lists, made from the MR
 * as the forge has it then, so two at once could undo each other. */
const peopleQueues = new Map<string, Promise<boolean>>();

/**
 * Adds or removes one reviewer or assignee from the MR/PR view: shown at once in the detail, then
 * sent (one change at a time per MR); a refusal puts it back and a toast says why. No confirm:
 * it's undone the same way (AGENTS.md's confirm model). `replace` (a project that allows one):
 * the added one takes their place, in the same write.
 */
export function changeMrPeople(tabId: string, kind: ForgeKind, number: number, role: PeopleRole, change: { add: ForgeUser; replace?: ForgeUser[] } | { remove: ForgeUser }): Promise<boolean> {
  const adding = 'add' in change;
  const who = adding ? change.add : change.remove;
  const replaced = adding ? (change.replace ?? []).filter((u) => u.id !== who.id) : [];
  let at = -1;
  let before: ForgeUser[] | null = null;
  patchPeople(tabId, number, role, (list) => {
    before = list;
    at = list.findIndex((u) => u.id === who.id);
    if (adding) return at === -1 ? [...list.filter((u) => !replaced.some((r) => r.id === u.id)), who] : list;
    return list.filter((u) => u.id !== who.id);
  });
  const ref = mrRef(kind, number);
  const failure = adding ? `Couldn't add ${who.name} as ${role === 'reviewers' ? 'a reviewer' : 'an assignee'} on ${ref}` : `Couldn't remove ${who.name} from the ${role} of ${ref}`;
  const people = adding ? { add: [who.id], remove: replaced.map((u) => u.id) } : { add: [], remove: [who.id] };
  const edit: MrEdit = { title: null, description: null, labels: null, [role]: people };
  const key = `${tabId}:${number}`;
  const run = (peopleQueues.get(key) ?? Promise.resolve(true)).then(async () => {
    const out = await forgeWrite(tabId, failure, (repo) => api.forgeEditMr(repo, number, edit));
    if (out) {
      putMr(tabId, out.value);
      return true;
    }
    // Back as it was: an added one out again (a swap: the list as it was), a removed one back in its place.
    patchPeople(tabId, number, role, (list) => {
      if (adding && replaced.length > 0 && before) return before;
      if (adding) return list.filter((u) => u.id !== who.id);
      if (list.some((u) => u.id === who.id)) return list;
      const next = [...list];
      next.splice(at === -1 ? next.length : Math.min(at, next.length), 0, who);
      return next;
    });
    return false;
  });
  peopleQueues.set(key, run);
  void run.finally(() => { if (peopleQueues.get(key) === run) peopleQueues.delete(key); });
  return run;
}

function patchPeople(tabId: string, number: number, role: PeopleRole, change: (list: ForgeUser[]) => ForgeUser[]): void {
  patchForge(tabId, (f) => {
    const d = f.details[number];
    return d ? { details: { ...f.details, [number]: { value: { ...d.value, [role]: change(d.value[role]) }, at: d.at } } } : {};
  });
}
