import { create } from 'zustand';
import { api } from '../../api/client';
import type { ForgeDiscussion } from '../../api/gen/ForgeDiscussion';
import type { ForgeKind } from '../../api/gen/ForgeKind';
import type { ForgeMr } from '../../api/gen/ForgeMr';
import type { ForgeNote } from '../../api/gen/ForgeNote';
import type { ForgeReaction } from '../../api/gen/ForgeReaction';
import { forgeOf, patchForge } from '../mrStore';
import { draftKey, setDraft, useReplyDrafts } from './drafts';
import { forgeWrite } from './writes';

/**
 * A comment's actions in the MR/PR view: reactions (shown at once, put back if the forge refuses),
 * edit and delete (the user's own comments only), its permalink, quote reply, and a thread's
 * Resolve (shown at once too).
 */

/** GitHub's eight reactions, in its order, and their emoji. */
export const GITHUB_REACTIONS: ReadonlyArray<readonly [string, string]> = [['+1', '👍'], ['-1', '👎'], ['laugh', '😄'], ['hooray', '🎉'], ['confused', '😕'], ['heart', '❤️'], ['rocket', '🚀'], ['eyes', '👀']];
/** GitLab's picker starts with these (any emoji name goes; the rest are a search away). */
export const GITLAB_COMMON: ReadonlyArray<readonly [string, string]> = [['thumbsup', '👍'], ['thumbsdown', '👎'], ['smile', '😄'], ['tada', '🎉'], ['confused', '😕'], ['heart', '❤️'], ['rocket', '🚀'], ['eyes', '👀']];

/** The emoji for a reaction's name, when it's one of the forge's common ones (else the caller
 * looks the shortcode up). */
export function knownGlyph(kind: ForgeKind, name: string): string | null {
  return (kind === 'github' ? GITHUB_REACTIONS : GITLAB_COMMON).find(([n]) => n === name)?.[1] ?? null;
}

/** A comment's web address: GitHub's own `html_url`, GitLab's MR address + `#note_<id>`. */
export function notePermalink(kind: ForgeKind, mr: Pick<ForgeMr, 'webUrl'>, n: Pick<ForgeNote, 'id' | 'webUrl'>): string | null {
  if (kind === 'github') return n.webUrl ?? null;
  return mr.webUrl && /^\d+$/.test(n.id) ? `${mr.webUrl}#note_${n.id}` : null;
}

/** GitHub's review summaries (`review-…`) take no reactions and can't be changed here. */
export const changeableThread = (kind: ForgeKind, d: Pick<ForgeDiscussion, 'id'>) => !(kind === 'github' && d.id.startsWith('review-'));

/** `list` with the user's `name` reaction added (`on`) or taken away. */
export function toggled(list: ForgeReaction[], name: string, on: boolean, who: string | null): ForgeReaction[] {
  const at = list.findIndex((r) => r.name === name);
  if (on) {
    if (at === -1) return [...list, { name, count: 1, mine: true, users: who ? [who] : [] }];
    const r = list[at]!;
    if (r.mine) return list;
    return list.map((x, i) => (i === at ? { ...r, count: r.count + 1, mine: true, users: who ? [...r.users, who] : r.users } : x));
  }
  if (at === -1 || !list[at]!.mine) return list;
  const r = list[at]!;
  if (r.count <= 1) return list.filter((_, i) => i !== at);
  return list.map((x, i) => (i === at ? { ...r, count: r.count - 1, mine: false, users: who ? r.users.filter((u) => u !== who) : r.users } : x));
}

/** `list` with note `id` of discussion `discussion` changed (`null` removes it, and its
 * discussion with it once no comment is left). */
export function withNote(list: ForgeDiscussion[], discussion: string, id: string, change: (n: ForgeNote) => ForgeNote | null): ForgeDiscussion[] {
  const out: ForgeDiscussion[] = [];
  for (const d of list) {
    if (d.id !== discussion) { out.push(d); continue; }
    const notes = d.notes.flatMap((n) => (n.id === id ? (change(n) ?? []) : [n]));
    if (notes.some((n) => !n.system)) out.push({ ...d, notes });
  }
  return out;
}

function patchThreads(tabId: string, number: number, change: (list: ForgeDiscussion[]) => ForgeDiscussion[]): void {
  patchForge(tabId, (f) => (f.discussions[number] ? { discussions: { ...f.discussions, [number]: change(f.discussions[number]!) } } : {}));
}

const noteNow = (tabId: string, number: number, discussion: string, id: string): ForgeNote | null =>
  forgeOf(tabId).discussions[number]?.find((d) => d.id === discussion)?.notes.find((n) => n.id === id) ?? null;

const setReactions = (tabId: string, number: number, discussion: string, id: string, reactions: ForgeReaction[]) =>
  patchThreads(tabId, number, (l) => withNote(l, discussion, id, (n) => ({ ...n, reactions })));

/** Each note's reaction writes, one after the other (two quick clicks can't cross). */
const reactQueues = new Map<string, Promise<unknown>>();

/** Toggles the user's `name` reaction on a note: shown at once, then sent; the forge's answer
 * replaces it, a refusal puts it back and a toast says why. */
export function toggleReaction(tabId: string, number: number, discussion: string, id: string, name: string): Promise<boolean> {
  const before = noteNow(tabId, number, discussion, id)?.reactions ?? [];
  const on = !before.some((r) => r.name === name && r.mine);
  const me = forgeOf(tabId).me;
  setReactions(tabId, number, discussion, id, toggled(before, name, on, me));
  const key = `${tabId}:${number}:${id}`;
  const run = (reactQueues.get(key) ?? Promise.resolve()).then(async () => {
    const out = await forgeWrite(tabId, on ? "Couldn't add the reaction" : "Couldn't remove the reaction", (repo) => api.forgeReact(repo, number, { discussion, note: id }, name, on));
    const now = noteNow(tabId, number, discussion, id)?.reactions ?? [];
    // Refused: this one change undone, whatever else changed meanwhile.
    setReactions(tabId, number, discussion, id, out ? out.value : toggled(now, name, !on, me));
    return out !== null;
  });
  reactQueues.set(key, run);
  void run.finally(() => { if (reactQueues.get(key) === run) reactQueues.delete(key); });
  return run;
}

/** Saves a comment's new text; the forge's answer (its body) goes in. True when it worked. */
export async function saveNote(tabId: string, number: number, discussion: string, id: string, body: string): Promise<boolean> {
  const out = await forgeWrite(tabId, "Couldn't save the comment", (repo) => api.forgeEditNote(repo, number, { discussion, note: id }, body));
  if (!out) return false;
  patchThreads(tabId, number, (l) => withNote(l, discussion, id, (n) => ({ ...n, body: out.value.body, bodyHtml: out.value.bodyHtml })));
  return true;
}

/** Deletes a comment; it leaves the thread (the thread too, when it was its only comment). */
export async function deleteNote(tabId: string, number: number, discussion: string, id: string): Promise<boolean> {
  const out = await forgeWrite(tabId, "Couldn't delete the comment", (repo) => api.forgeDeleteNote(repo, number, { discussion, note: id }));
  if (!out) return false;
  patchThreads(tabId, number, (l) => withNote(l, discussion, id, () => null));
  return true;
}

const setResolved = (tabId: string, number: number, discussion: string, resolved: boolean, resolvedBy: string | null) =>
  patchThreads(tabId, number, (l) => l.map((d) => (d.id === discussion ? { ...d, resolved, resolvedBy: resolvedBy ?? undefined } : d)));

/** Resolves a thread, or unresolves it: shown at once, put back (with the forge's reason) if refused. */
export async function resolveThread(tabId: string, number: number, discussion: string, resolved: boolean): Promise<boolean> {
  const d = forgeOf(tabId).discussions[number]?.find((x) => x.id === discussion);
  if (!d) return false;
  setResolved(tabId, number, discussion, resolved, resolved ? (forgeOf(tabId).me ?? null) : null);
  const out = await forgeWrite(tabId, resolved ? "Couldn't resolve the thread" : "Couldn't unresolve the thread", (repo) => api.forgeResolve(repo, number, discussion, resolved));
  if (out) setResolved(tabId, number, discussion, out.value.resolved, out.value.resolvedBy);
  else setResolved(tabId, number, discussion, d.resolved, d.resolvedBy ?? null);
  return out !== null;
}

/** Quote reply: the comment as a Markdown quote in the reply box its answer goes to (the thread's;
 * GitHub's conversation: the new comment's), after what's there. */
export function quoteReply(tabId: string, kind: ForgeKind, number: number, d: Pick<ForgeDiscussion, 'id'>, body: string): string {
  const target = kind === 'github' && !d.id.startsWith('thread-') ? null : d.id;
  const key = draftKey(tabId, number, target);
  const quote = body.trimEnd().split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n');
  const now = useReplyDrafts.getState().text[key] ?? '';
  setDraft(key, `${now ? `${now.trimEnd()}\n\n` : ''}${quote}\n\n`);
  return key;
}

/** Which threads the user expanded or collapsed this session (by tab, MR/PR and thread); the
 * rest follow the default (a resolved thread's replies collapsed). */
export const useThreadFolds = create<{ open: Record<string, boolean> }>(() => ({ open: {} }));
export const foldKey = (tabId: string, number: number, discussion: string) => `${tabId}:${number}:${discussion}`;
export const setFold = (key: string, open: boolean) => useThreadFolds.setState((s) => ({ open: { ...s.open, [key]: open } }));
