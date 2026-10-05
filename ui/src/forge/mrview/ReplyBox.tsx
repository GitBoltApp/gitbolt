import { CornerDownLeft } from 'lucide-react';
import { useState } from 'react';
import { api } from '../../api/client';
import type { ForgeDiscussion } from '../../api/gen/ForgeDiscussion';
import type { ForgeKind } from '../../api/gen/ForgeKind';
import type { ForgeNote } from '../../api/gen/ForgeNote';
import { MarkdownField } from '../../markdown/MarkdownField';
import { registerKeyHints } from '../../shortcuts/hints';
import { mrRef } from '../labels';
import { patchForge, useTabForgeField } from '../mrStore';
import { clearDraft, draftKey, setDraft, useReplyDrafts } from './drafts';
import { forgeWrite } from './writes';

/** The note in its discussion (a new one at the end), as the forge answered it. */
export function appendNote(list: ForgeDiscussion[], discussion: string | null, note: ForgeNote): ForgeDiscussion[] {
  if (discussion && list.some((d) => d.id === discussion)) return list.map((d) => (d.id === discussion ? { ...d, notes: [...d.notes, note] } : d));
  return [...list, { id: `new-${note.id}`, notes: [note], resolvable: false, resolved: false }];
}

/** A comment (`discussion` null) or a reply in a discussion. Ctrl+Enter sends. */
export function ReplyBox({ tabId, number, discussion, onDone }: { tabId: string; number: number; discussion: string | null; onDone?: () => void }) {
  const key = draftKey(tabId, number, discussion);
  const text = useReplyDrafts((s) => s.text[key] ?? '');
  const kind = useTabForgeField(tabId, 'kind');
  const [busy, setBusy] = useState(false);
  const action = discussion ? 'Reply' : 'Comment';
  const ready = text.trim() !== '' && !busy;
  const send = async () => {
    if (!ready) return;
    setBusy(true);
    const ref = mrRef(kind ?? 'gitlab', number);
    const out = await forgeWrite(tabId, discussion ? `Couldn't reply on ${ref}` : `Couldn't comment on ${ref}`, (repo) => api.forgeReply(repo, number, discussion, text));
    setBusy(false);
    if (!out) return;
    if ((useReplyDrafts.getState().text[key] ?? '') === text) clearDraft(key);
    patchForge(tabId, (f) => ({ discussions: { ...f.discussions, [number]: appendNote(f.discussions[number] ?? [], discussion, out.value) } }));
    onDone?.();
  };
  return (
    <form className="mr-reply" aria-label={action} onSubmit={(e) => { e.preventDefault(); void send(); }}>
      {/* --- 5A T9: Write / Preview --- */}
      <MarkdownField
        label={discussion ? 'Reply' : 'Write a comment'}
        placeholder={discussion ? 'Write a reply' : 'Write a comment'}
        value={text}
        onChange={(v) => setDraft(key, v)}
        flavor={kind ?? 'gitlab'}
        context={{ kind: 'forge', tabId }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void send();
          }
        }}
      />
      {/* --- end 5A T9 --- */}
      <div className="mr-form-row">
        {onDone && <button type="button" className="mr-button" onClick={onDone}>Cancel</button>}
        <button type="submit" className="mr-button primary" disabled={!ready}>{busy ? 'Sending…' : action}</button>
      </div>
    </form>
  );
}

/** A discussion's own reply (GitLab: any; GitHub: review threads, the conversation has none). It
 * opens by itself when a draft waits in it. */
export function ThreadReply({ tabId, kind, number, d }: { tabId: string; kind: ForgeKind; number: number; d: ForgeDiscussion }) {
  const hasDraft = useReplyDrafts((s) => (s.text[draftKey(tabId, number, d.id)] ?? '') !== '');
  const [open, setOpen] = useState(false);
  if (kind === 'github' && !d.id.startsWith('thread-')) return null;
  if (!open && !hasDraft) return <div className="mr-thread-foot"><button type="button" className="mr-button" onClick={() => setOpen(true)}><CornerDownLeft size={12} aria-hidden /> Reply</button></div>;
  return <div className="mr-thread-foot"><ReplyBox tabId={tabId} number={number} discussion={d.id} onDone={() => { clearDraft(draftKey(tabId, number, d.id)); setOpen(false); }} /></div>;
}

// Shown in the Keyboard Shortcuts panel (Ctrl+/); metadata only.
registerKeyHints([
  { id: 'key.mrReply', section: 'Merge request', label: 'Send the comment or reply', keys: ['Ctrl+Enter'], context: '(when writing a comment)', source: 'forge/mrview/ReplyBox.tsx' },
]);
