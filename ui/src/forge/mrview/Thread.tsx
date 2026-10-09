import { AtSign, Check, ChevronRight, CircleAlert, CircleDot, CircleX, GitCommitHorizontal, GitMerge, GitPullRequestDraft, MessageSquare, Pencil, Tag, Type, type LucideIcon } from 'lucide-react';
import { memo, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ForgeDiscussion } from '../../api/gen/ForgeDiscussion';
import type { ForgeKind } from '../../api/gen/ForgeKind';
import type { ForgeMr } from '../../api/gen/ForgeMr';
import type { ForgeNote } from '../../api/gen/ForgeNote';
import type { ForgeReview } from '../../api/gen/ForgeReview';
import type { ForgeUser } from '../../api/gen/ForgeUser';
import { ForgeAvatar } from '../../avatars/Avatar';
import { EmojiText } from '../emoji';
import { useForge } from '../mrStore';
import { changeableThread, foldKey, notePermalink, setFold, useThreadFolds } from './noteActionsStore';
import { linkMenu, linkMenuAt, NoteActions, NoteEditor, ReactionPills, ResolveButton } from './NoteActions';
import { RelTime } from './RelTime';
// --- 5A T10 ---
import { signedAttachments } from '../../markdown/attachments';
import { Markdown } from '../../markdown/lazy';
import { MR_BODY_MAX_BYTES } from '../../markdown/limits';
import { whenIdle } from '../../markdown/idle';
import { PlainBody } from '../../markdown/PlainBody';
// --- end 5A T10 ---
import { PendingMark } from '../../pending/PendingMark';
import { openInBrowser } from './MrHeader';
import { noteWhere } from './noteLine';
import { openNoteFile } from './openNote';
import { ThreadReply } from './ReplyBox';
import { parseSystemNote, type NotePart, type SystemKind, type SystemNote } from './systemNote';

type EventKind = SystemKind | 'review';

const KIND_ICONS: Record<EventKind, LucideIcon> = {
  commits: GitCommitHorizontal, edit: Pencil, title: Type, mention: AtSign, approved: Check, unapproved: CircleAlert, merged: GitMerge,
  closed: CircleX, reopened: CircleDot, draft: GitPullRequestDraft, label: Tag, other: CircleDot, review: MessageSquare,
};

function Node({ kind, icon }: { kind: string; icon?: LucideIcon }) {
  const Icon = icon ?? KIND_ICONS[kind as EventKind] ?? CircleDot;
  return <span className={`mr-node kind-${kind}`} aria-hidden><Icon size={12} /></span>;
}

/** A system note's parts as React text and elements: nothing is ever parsed as HTML. */
function NoteParts({ parts }: { parts: NotePart[] }) {
  return (
    <>
      {parts.map((p, i) => {
        switch (p.t) {
          case 'text': return <span key={i}><EmojiText text={p.text} /></span>;
          case 'code': return <code key={i} className="mr-code"><EmojiText text={p.text} /></code>;
          case 'del': return <del key={i}>{p.text}</del>;
          case 'ins': return <ins key={i}>{p.text}</ins>;
          case 'link': return <button key={i} type="button" className="mr-link" onClick={() => openInBrowser(p.url)}>{p.text}</button>;
          case 'commits': return (
            <ul key={i} className="mr-commits">
              {p.items.map((c, j) => <li key={j}>{c.sha && <span className="mr-sha">{c.sha}</span>}<span>{c.subject}</span></li>)}
              {p.more > 0 && <li className="mr-when">and {p.more} more commit{p.more === 1 ? '' : 's'}</li>}
            </ul>
          );
        }
      })}
    </>
  );
}

/** One forge-generated event on the timeline: the bold actor, what happened, a dim time. */
function SystemEvent({ n, kind, parts }: { n: { author: ForgeUser; createdAt: number }; kind: EventKind; parts: NotePart[] }) {
  return (
    <div className="mr-ev mr-system" data-kind={kind}>
      <Node kind={kind} />
      <div className="mr-ev-line"><b className="mr-who">{n.author.name}</b> <NoteParts parts={parts} /><RelTime at={n.createdAt} /></div>
    </div>
  );
}

/** A thread's own system note ("changed this line in version 2 of the diff"), compact, among
 * the thread's comments: the forge's icon, the actor, what happened (its links open the browser),
 * a dim time. */
function ThreadEvent({ n, webUrl }: { n: ForgeNote; webUrl: string }) {
  const p = parseOnce(n, webUrl);
  return (
    <div className="mr-thread-sys" data-kind={p.kind} data-note={n.id}>
      <Node kind={p.kind} />
      <div className="mr-ev-line"><b className="mr-who">{n.author.name}</b> <NoteParts parts={p.parts} /><RelTime at={n.createdAt} /></div>
    </div>
  );
}

/** Bodies rendered in the first paint; the rest follow, a few per idle callback, so opening a
 * long MR/PR isn't one long task. */
export const FIRST_BODIES = 20;
const BODIES_PER_IDLE = 5;

/** A comment, memoized on its data: a poll that changes nothing re-renders none. `deferred`: its
 * plain text holds the place until the timeline's idle rendering reaches it. The thread's first
 * comment has its author's avatar on the timeline (and its Resolve, for a resolvable thread); a
 * reply has a small one in its header. Its actions (react, ⋮) sit at the header's right end. */
const Note = memo(function Note({ tabId, kind, mr, d, n, first, deferred, where }: { tabId: string; kind: ForgeKind; mr: ForgeMr; d: ForgeDiscussion; n: ForgeNote; first: boolean; deferred: boolean; where?: ReactNode }) {
  const text = useMemo(() => signedAttachments(n.body, n.bodyHtml ?? null), [n.body, n.bodyHtml]);
  const context = useMemo(() => ({ kind: 'forge', tabId }) as const, [tabId]);
  const me = useForge((s) => s.byTab[tabId]?.me ?? null);
  const [editing, setEditing] = useState(false);
  const link = notePermalink(kind, mr, n);
  const reactable = changeableThread(kind, d);
  return (
    <div className={`mr-note${first ? '' : ' mr-reply-note'}`} data-note={n.id}>
      <div className="mr-note-head">
        {!first && <ForgeAvatar user={n.author} size={18} />}
        <b>{n.author.name}</b>
        <RelTime at={n.createdAt} onContextMenu={link ? (e) => linkMenu(e, link) : undefined} onOpenMenu={link ? (el) => linkMenuAt(el, link) : undefined} />
        <span className="mr-spacer" />
        <NoteActions tabId={tabId} kind={kind} number={mr.number} d={d} n={n} link={link} mine={me !== null && n.author.username === me} reactable={reactable} onEdit={() => setEditing(true)} />
        {first && d.resolvable && <ResolveButton tabId={tabId} number={mr.number} d={d} />}
      </div>
      {where}
      {editing
        ? <NoteEditor tabId={tabId} kind={kind} number={mr.number} d={d} n={n} onDone={() => setEditing(false)} />
        : (
          // --- 5A T10: rendered Markdown (spec #5 §2: every comment) ---
          <div className="mr-note-body">
            {deferred ? <PlainBody text={text} className="md" /> : <Markdown text={text} flavor={kind} context={context} maxBytes={MR_BODY_MAX_BYTES} />}
          </div>
        )}
      <ReactionPills tabId={tabId} kind={kind} number={mr.number} d={d} n={n} />
    </div>
  );
});

/** A thread's replies: unfolded, just "Collapse replies"; folded, a toggle with the repliers'
 * avatars (up to 3), how many, and who replied last, when. */
function RepliesRow({ replies, open, toggle }: { replies: ForgeNote[]; open: boolean; toggle: () => void }) {
  const people = [...new Map(replies.map((n) => [n.author.username, n.author])).values()].slice(0, 3);
  const last = replies[replies.length - 1]!;
  return (
    <div className="mr-replies-row" onClick={toggle}>
      <button type="button" className="mr-replies-toggle" aria-expanded={open} aria-label={open ? 'Collapse replies' : `${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}`} onClick={(e) => { e.stopPropagation(); toggle(); }}>
        <ChevronRight size={14} className="mr-replies-chevron" aria-hidden />
        {open
          ? <span aria-hidden>Collapse replies</span>
          : (
            <>
              <span className="mr-replies-faces" aria-hidden>{people.map((u) => <ForgeAvatar key={u.username} user={u} size={18} />)}</span>
              <span className="mr-replies-count" aria-hidden>{replies.length} {replies.length === 1 ? 'reply' : 'replies'}</span>
            </>
          )}
      </button>
      {!open && <span className="mr-replies-last">Last reply by {last.author.name}<RelTime at={last.createdAt} /></span>}
    </div>
  );
}

/** One discussion as a card: the diff note's `file:line` (which opens the file) and snippet, its
 * first comment, its replies (a resolved thread's folded by default; the user's choice kept for
 * the session), and Reply at the bottom while unfolded. `firstBody`: the timeline's count of
 * comment bodies before this thread; `rendered`: how many render yet. `showWhere` (default true): its
 * `file:line` and snippet; a card at its line in the diff (review mode) leaves them out. */
export const Discussion = memo(function Discussion({ tabId, kind, mr, d, firstBody = 0, rendered = Infinity, showWhere = true }: {
  tabId: string; kind: ForgeKind; mr: ForgeMr; d: ForgeDiscussion; firstBody?: number; rendered?: number; showWhere?: boolean;
}) {
  const key = foldKey(tabId, mr.number, d.id);
  const chosen = useThreadFolds((s) => s.open[key]);
  const notes = d.notes.filter((n) => !n.system);
  if (notes.length === 0) return null;
  const replies = notes.slice(1);
  // After the first comment: the replies and the thread's own system notes, in the forge's order.
  const rest = d.notes.filter((n) => n !== notes[0]);
  const open = replies.length === 0 || (chosen ?? !d.resolved);
  const pos = d.notes.find((n) => n.position)?.position ?? null;
  return (
    <article className="mr-discussion" aria-label={`Thread by ${notes[0]!.author.name}`} data-resolved={d.resolved || undefined}>
      <Note tabId={tabId} kind={kind} mr={mr} d={d} n={notes[0]!} first deferred={firstBody >= rendered} where={
        showWhere && pos ? (
                <div className="mr-pos">
                  <button type="button" className="mr-link mr-where" onClick={() => void openNoteFile(tabId, kind, mr, pos)}>{noteWhere(pos)}</button>
                  {pos.snippet && <pre className="mr-snippet">{pos.snippet}</pre>}
                </div>
              ) : undefined
      } />
      {replies.length > 0 && <RepliesRow replies={replies} open={open} toggle={() => setFold(key, !open)} />}
      {open && rest.map((n) => (n.system
        ? <ThreadEvent key={n.id} n={n} webUrl={mr.webUrl} />
        : <Note key={n.id} tabId={tabId} kind={kind} mr={mr} d={d} n={n} first={false} deferred={firstBody + replies.indexOf(n) + 1 >= rendered} />))}
      {/* --- 4B T13: reply in this thread --- */}
      {open && <ThreadReply tabId={tabId} kind={kind} number={mr.number} d={d} />}
      {/* --- end 4B T13 --- */}
    </article>
  );
});

const bodiesOf = (d: ForgeDiscussion) => d.notes.reduce((c, n) => c + (n.system ? 0 : 1), 0);

type Entry =
  | { at: number; key: string; t: 'system'; note: ForgeNote }
  | { at: number; key: string; t: 'thread'; d: ForgeDiscussion }
  | { at: number; key: string; t: 'review'; r: ForgeReview };

const REVIEW_WORDS: Record<string, { kind: EventKind; text: string }> = {
  approved: { kind: 'approved', text: 'approved these changes' },
  changesRequested: { kind: 'unapproved', text: 'requested changes' },
  commented: { kind: 'review', text: 'reviewed' },
};

/** The timeline's entries by time; a thread sits at its first note's time. GitHub's reviews are
 * events too (GitHub has no system notes). */
export function entriesOf(discussions: ForgeDiscussion[], reviews: ForgeReview[]): Entry[] {
  const out: Entry[] = [];
  for (const d of discussions) {
    if (d.notes.length > 0 && d.notes.every((n) => n.system)) d.notes.forEach((n) => out.push({ at: n.createdAt, key: `s${d.id}-${n.id}`, t: 'system', note: n }));
    // A thread's own system notes ("changed this line…") show inside it, not on the timeline.
    else if (d.notes.some((n) => !n.system)) out.push({ at: d.notes.find((n) => !n.system)!.createdAt, key: `d${d.id}`, t: 'thread', d });
  }
  for (const r of reviews) if (r.submittedAt !== null && REVIEW_WORDS[r.state]) out.push({ at: r.submittedAt, key: `r${r.user.username}-${r.submittedAt}-${r.state}`, t: 'review', r });
  return out.map((e, i) => [e, i] as const).sort(([a, i], [b, j]) => a.at - b.at || i - j).map(([e]) => e);
}

/** A note's parse, kept per note: a poll re-renders the timeline, the parse is not redone. */
const parsed = new WeakMap<ForgeNote, { url: string; body: string; note: SystemNote }>();
function parseOnce(n: ForgeNote, url: string): SystemNote {
  const hit = parsed.get(n);
  if (hit && hit.url === url && hit.body === n.body) return hit.note;
  const note = parseSystemNote(n.body, url);
  parsed.set(n, { url, body: n.body, note });
  return note;
}

type Tab = 'activity' | 'comments' | 'diff';

/** The activity area (spec #4 §2): tabs Activity / Comments / Diff notes over a vertical timeline
 * of forge events and comment-thread cards. */
export function Thread({ tabId, kind, mr, discussions, reviews = [] }: { tabId: string; kind: ForgeKind; mr: ForgeMr; discussions: ForgeDiscussion[] | null; reviews?: ForgeReview[] }) {
  const [tab, setTab] = useState<Tab>('activity');
  const entries = useMemo(() => entriesOf(discussions ?? [], kind === 'github' ? reviews : []), [discussions, reviews, kind]);
  const loading = discussions === null;
  const threads = entries.filter((e): e is Extract<Entry, { t: 'thread' }> => e.t === 'thread');
  const diffs = threads.filter((e) => e.d.notes.some((n) => n.position));
  const shown = tab === 'activity' ? entries : tab === 'comments' ? threads : diffs;
  const tabs: Array<[Tab, string, number | null]> = [['activity', 'Activity', null], ['comments', 'Comments', threads.length], ['diff', 'Diff notes', diffs.length]];
  // How many comment bodies render as Markdown yet: the first FIRST_BODIES, then more per idle callback.
  const bodies = shown.reduce((c, e) => c + (e.t === 'thread' ? bodiesOf(e.d) : 0), 0);
  const [rendered, setRendered] = useState(FIRST_BODIES);
  useEffect(() => {
    if (rendered >= bodies) return;
    return whenIdle(() => setRendered((r) => r + BODIES_PER_IDLE));
  }, [rendered, bodies]);
  let body = 0;
  return (
    <section className="mr-activity" aria-label="Activity">
      <div className="mr-tabs" role="tablist" aria-label="Activity views">
        {tabs.map(([id, label, count]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={`mr-tab${tab === id ? ' on' : ''}`} onClick={() => setTab(id)}>
            {label}{count !== null && <span className="mr-count">{count}</span>}
          </button>
        ))}
      </div>
      <div className="mr-timeline" role="tabpanel">
        {loading && <p className="mr-dim mr-loading"><PendingMark action="fetch" size={14} label="Loading the discussion" /></p>}
        {!loading && shown.length === 0 && <p className="mr-dim">{tab === 'activity' ? 'No comments yet' : tab === 'comments' ? 'No comments yet' : 'No diff notes'}</p>}
        {shown.map((e) => {
          if (e.t === 'system') {
            const p = parseOnce(e.note, mr.webUrl);
            return <SystemEvent key={e.key} n={e.note} kind={p.kind} parts={p.parts} />;
          }
          if (e.t === 'review') {
            const w = REVIEW_WORDS[e.r.state]!;
            return <SystemEvent key={e.key} n={{ author: e.r.user, createdAt: e.at }} kind={w.kind} parts={[{ t: 'text', text: w.text }]} />;
          }
          const firstBody = body;
          body += bodiesOf(e.d);
          const author = e.d.notes.find((n) => !n.system)!.author;
          return (
            <div key={e.key} className="mr-ev mr-thread-ev" data-diff={e.d.notes.some((n) => n.position) || undefined}>
              {/* The thread's first comment's author, on the timeline. */}
              <span className="mr-node mr-node-avatar" aria-hidden><ForgeAvatar user={author} size={22} /></span>
              <Discussion tabId={tabId} kind={kind} mr={mr} d={e.d} firstBody={firstBody} rendered={rendered} />
            </div>
          );
        })}
      </div>
    </section>
  );
}
