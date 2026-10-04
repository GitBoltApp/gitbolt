import type { ForgeDiscussion } from '../../api/gen/ForgeDiscussion';
import type { ForgeKind } from '../../api/gen/ForgeKind';
import type { ForgeMr } from '../../api/gen/ForgeMr';
import type { ForgeNote } from '../../api/gen/ForgeNote';
import { Avatar } from '../../avatars/Avatar';
import { relativeTime } from '../../format/relative';
import { openNoteFile } from './openNote';
import { ThreadReply } from './ReplyBox';

function Note({ n }: { n: ForgeNote }) {
  return (
    <div className="mr-note">
      <div className="mr-note-head">
        <Avatar name={n.author.name} email={n.author.email ?? ''} size={16} request={!!n.author.email} />
        <b>{n.author.name}</b>
        <span className="mr-dim">{relativeTime(n.createdAt)}</span>
      </div>
      <div className="mr-note-body">{n.body}</div>
    </div>
  );
}

/** One discussion: its notes, the diff note's `file:line` (which opens the file) and snippet. A
 * forge's own notes ("added 1 commit") are one dim line. */
export function Discussion({ tabId, kind, mr, d }: { tabId: string; kind: ForgeKind; mr: ForgeMr; d: ForgeDiscussion }) {
  const first = d.notes[0];
  if (!first) return null;
  if (d.notes.every((n) => n.system)) {
    return <div className="mr-system">{first.author.name} {first.body} · {relativeTime(first.createdAt)}</div>;
  }
  const pos = d.notes.find((n) => n.position)?.position ?? null;
  const line = pos ? pos.line ?? pos.oldLine : null;
  return (
    <article className="mr-discussion" aria-label={`Thread by ${first.author.name}`}>
      {pos && (
        <div className="mr-pos">
          <button type="button" className="mr-link" onClick={() => void openNoteFile(tabId, kind, mr, pos.path)}>{pos.path}{line !== null ? `:${line}` : ''}</button>
          {pos.snippet && <pre className="mr-snippet">{pos.snippet}</pre>}
        </div>
      )}
      {d.notes.map((n) => <Note key={n.id} n={n} />)}
      {d.resolved && <div className="mr-dim">Resolved</div>}
      {/* --- 4B T13: reply in this thread --- */}
      <ThreadReply tabId={tabId} kind={kind} number={mr.number} d={d} />
      {/* --- end 4B T13 --- */}
    </article>
  );
}

/** The discussion (spec #4 §2: plain text; diff-line notes in the thread with `file:line`). */
export function Thread({ tabId, kind, mr, discussions }: { tabId: string; kind: ForgeKind; mr: ForgeMr; discussions: ForgeDiscussion[] | null }) {
  if (discussions === null) return <p className="mr-dim">Loading the discussion…</p>;
  return (
    <section className="mr-thread-list" aria-label="Discussion">
      {discussions.length === 0 && <p className="mr-dim">No comments yet</p>}
      {discussions.map((d) => <Discussion key={d.id} tabId={tabId} kind={kind} mr={mr} d={d} />)}
    </section>
  );
}
