import { AtSign, Check, CircleAlert, CircleDot, CircleX, GitCommitHorizontal, GitMerge, GitPullRequestDraft, MessageSquare, Pencil, Tag, Type, type LucideIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { ForgeDiscussion } from '../../api/gen/ForgeDiscussion';
import type { ForgeKind } from '../../api/gen/ForgeKind';
import type { ForgeMr } from '../../api/gen/ForgeMr';
import type { ForgeNote } from '../../api/gen/ForgeNote';
import type { ForgeReview } from '../../api/gen/ForgeReview';
import type { ForgeUser } from '../../api/gen/ForgeUser';
import { ForgeAvatar } from '../../avatars/Avatar';
import { relativeTime } from '../../format/relative';
import { EmojiText } from '../emoji';
import { openInBrowser } from './MrHeader';
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
      <div className="mr-ev-line"><b className="mr-who">{n.author.name}</b> <NoteParts parts={parts} /> <span className="mr-when">· {relativeTime(n.createdAt)}</span></div>
    </div>
  );
}

function Note({ n, reply, resolved }: { n: ForgeNote; reply: boolean; resolved: boolean }) {
  return (
    <div className={`mr-note${reply ? ' mr-reply-note' : ''}`}>
      <ForgeAvatar user={n.author} size={28} />
      <div>
        <div className="mr-note-head">
          <b>{n.author.name}</b>
          <span className="mr-when">{relativeTime(n.createdAt)}</span>
          {resolved && <span className="mr-resolved">Resolved</span>}
        </div>
        <div className="mr-note-body">{n.body}</div>
      </div>
    </div>
  );
}

/** One discussion as a card: its notes (replies indented), the diff note's `file:line` (which
 * opens the file) and snippet, a Resolved chip, and Reply in its footer. */
export function Discussion({ tabId, kind, mr, d }: { tabId: string; kind: ForgeKind; mr: ForgeMr; d: ForgeDiscussion }) {
  const notes = d.notes.filter((n) => !n.system);
  if (notes.length === 0) return null;
  const pos = d.notes.find((n) => n.position)?.position ?? null;
  const line = pos ? pos.line ?? pos.oldLine : null;
  return (
    <article className="mr-discussion" aria-label={`Thread by ${notes[0]!.author.name}`}>
      {pos && (
        <div className="mr-pos">
          <button type="button" className="mr-link mr-where" onClick={() => void openNoteFile(tabId, kind, mr, pos.path)}>{pos.path}{line !== null ? `:${line}` : ''}</button>
          {pos.snippet && <pre className="mr-snippet">{pos.snippet}</pre>}
        </div>
      )}
      {notes.map((n, i) => <Note key={n.id} n={n} reply={i > 0} resolved={d.resolved && i === 0} />)}
      {/* --- 4B T13: reply in this thread --- */}
      <ThreadReply tabId={tabId} kind={kind} number={mr.number} d={d} />
      {/* --- end 4B T13 --- */}
    </article>
  );
}

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
    else if (d.notes.some((n) => !n.system)) {
      out.push({ at: d.notes.find((n) => !n.system)!.createdAt, key: `d${d.id}`, t: 'thread', d });
      // A forge note inside a human thread is still an event, at its own time.
      d.notes.filter((n) => n.system).forEach((n) => out.push({ at: n.createdAt, key: `s${d.id}-${n.id}`, t: 'system', note: n }));
    }
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
        {loading && <p className="mr-dim">Loading the discussion…</p>}
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
          return (
            <div key={e.key} className="mr-ev mr-thread-ev">
              <Node kind="thread" icon={MessageSquare} />
              <Discussion tabId={tabId} kind={kind} mr={mr} d={e.d} />
            </div>
          );
        })}
      </div>
    </section>
  );
}
