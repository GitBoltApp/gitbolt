import { CircleCheck, EllipsisVertical, Link, Pencil, Quote, SmilePlus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import { copyText } from '../../api/transport';
import type { ForgeDiscussion } from '../../api/gen/ForgeDiscussion';
import type { ForgeKind } from '../../api/gen/ForgeKind';
import type { ForgeNote } from '../../api/gen/ForgeNote';
import type { ForgeReaction } from '../../api/gen/ForgeReaction';
import { rankEmoji, loadEmojiList, type EmojiEntry } from '../../markdown/emojiComplete';
import { MarkdownField } from '../../markdown/MarkdownField';
import { ICONS } from '../../menu/icons';
import { openContextMenu, openMenuAt, useMenu } from '../../menu/menuStore';
import type { MenuRow } from '../../menu/types';
import { confirmAction } from '../../ui/ConfirmDialog';
import { HoverTooltip } from '../../ui/HoverTooltip';
import { registerKeys } from '../../ui/keyRouter';
import { registerKeyHints } from '../../shortcuts/hints';
import { escOwners } from '../../app/modalKeys';
import { currentOrigin } from '../../ui/arm/origin';
import { useToast } from '../../ui/toastStore';
import { useEmoji } from '../emoji';
import { openInBrowser } from './MrHeader';
import { deleteNote, GITHUB_REACTIONS, GITLAB_COMMON, knownGlyph, quoteReply, resolveThread, saveNote, toggleReaction } from './noteActionsStore';

const copyLink = (url: string) => { copyText(url).then(() => useToast.getState().show('Copied the link'), () => useToast.getState().show("Couldn't copy the link", { error: true })); };

/** A comment date's right-click menu: Copy link, Open in browser. */
export function linkMenu(e: MouseEvent<HTMLElement>, url: string): void {
  openContextMenu(e, () => linkRows(url));
}

/** The same menu, opened by a click on the date: below it, as the ⋮ button's is. */
export function linkMenuAt(el: HTMLElement, url: string): void {
  openMenuAt(el, linkRows(url), undefined, () => linkRows(url), 'Comment link');
}

const linkRows = (url: string): MenuRow[] => [
  { kind: 'action', id: 'note.copyLink', label: 'Copy link', icon: ICONS.forge, tooltip: `Copy ${url}`, run: () => copyLink(url) },
  { kind: 'action', id: 'note.openInBrowser', label: 'Open in browser', icon: ICONS.browser, tooltip: url, run: () => openInBrowser(url) },
];

/** A reaction's emoji: the forge's common ones by name, else GitLab's shortcode looked up. */
function Glyph({ kind, name }: { kind: ForgeKind; name: string }) {
  const looked = useEmoji(`:${name}:`);
  return <>{knownGlyph(kind, name) ?? looked}</>;
}

/** The reactions under a comment, as pills ("👍 3"); the user's are highlighted, and a click
 * toggles theirs. Nothing at all when there are none. */
export function ReactionPills({ tabId, kind, number, d, n }: { tabId: string; kind: ForgeKind; number: number; d: ForgeDiscussion; n: ForgeNote }) {
  const list: ForgeReaction[] = n.reactions ?? [];
  if (list.length === 0) return null;
  return (
    <div className="mr-reactions" role="group" aria-label="Reactions">
      {list.map((r) => {
        const pill = (
          <button key={r.name} type="button" className={`mr-pill${r.mine ? ' mine' : ''}`} aria-pressed={r.mine} aria-label={`${r.name}: ${r.count}${r.mine ? ', yours' : ''}`} onClick={() => void toggleReaction(tabId, number, d.id, n.id, r.name)}>
            <span className="mr-pill-glyph" aria-hidden><Glyph kind={kind} name={r.name} /></span>
            <span className="mr-pill-count" aria-hidden>{r.count}</span>
          </button>
        );
        return r.users.length > 0 ? <HoverTooltip key={r.name} content={`${r.users.join(', ')} reacted with :${r.name}:`}>{pill}</HoverTooltip> : pill;
      })}
    </div>
  );
}

/** The reaction picker: the forge's set (GitHub's eight; GitLab's common ones and a search of
 * every emoji name). Esc or a press outside closes it. */
function ReactionPicker({ kind, mineOf, pick, close }: { kind: ForgeKind; mineOf: (name: string) => boolean; pick: (name: string) => void; close: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [list, setList] = useState<readonly EmojiEntry[] | null>(null);
  useEffect(() => {
    const down = (e: PointerEvent) => { if (root.current && !root.current.contains(e.target as Node)) close(); };
    document.addEventListener('pointerdown', down, true);
    return () => document.removeEventListener('pointerdown', down, true);
  }, [close]);
  useEffect(() => {
    if (kind === 'gitlab' && query.trim() && !list) void loadEmojiList().then(setList, () => {});
  }, [kind, query, list]);
  useEffect(() => { root.current?.querySelector<HTMLElement>('button, input')?.focus(); }, []);
  // Esc closes the picker, not the view: an Esc owner (the MR view's flyout asks them first), and
  // an overlay key for an Esc from anywhere else.
  useEffect(() => {
    const own = () => { close(); return true; };
    escOwners.add(own);
    const off = registerKeys('overlay', (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      close();
      return 'handled';
    });
    return () => { escOwners.delete(own); off(); };
  }, [close]);
  const set = kind === 'github' ? GITHUB_REACTIONS : GITLAB_COMMON;
  const q = query.trim().replace(/^:|:$/g, '').toLowerCase();
  const hits = kind === 'gitlab' && q && list ? rankEmoji(list, q, 24) : [];
  const one = (name: string, glyph: string) => (
    <button key={name} type="button" className={`mr-pick${mineOf(name) ? ' mine' : ''}`} aria-label={`:${name}:`} aria-pressed={mineOf(name)} onClick={() => { pick(name); close(); }}>{glyph}</button>
  );
  return (
    <div ref={root} className="mr-picker" role="dialog" aria-label="Add reaction">
      {kind === 'gitlab' && <input className="mr-picker-search" type="search" aria-label="Search emoji" placeholder="Search emoji" value={query} onChange={(e) => setQuery(e.target.value)} />}
      <div className="mr-picker-grid">{q && kind === 'gitlab' ? hits.map((h) => one(h.name, h.emoji)) : set.map(([name, glyph]) => one(name, glyph))}</div>
      {q && kind === 'gitlab' && list && hits.length === 0 && <p className="mr-dim">No emoji named “{q}”</p>}
    </div>
  );
}

/**
 * A comment's header actions, right-aligned: Add reaction (a smiley: the picker) and ⋮ (Edit and
 * Delete on the user's own comments, Copy link, Quote reply). Shown while the comment is hovered or
 * focused, and while the picker or the menu is open.
 */
export function NoteActions({ tabId, kind, number, d, n, link, mine, reactable, onEdit }: {
  tabId: string; kind: ForgeKind; number: number; d: ForgeDiscussion; n: ForgeNote; link: string | null; mine: boolean; reactable: boolean; onEdit: () => void;
}) {
  const [picking, setPicking] = useState(false);
  const closePicker = useCallback(() => setPicking(false), []);
  const more = useRef<HTMLButtonElement>(null);
  const menuOpen = useMenu((s) => s.anchor !== null && s.anchor === more.current);
  const rows = (): MenuRow[] => [
    ...(mine && reactable ? [
      { kind: 'action' as const, id: 'note.edit', label: 'Edit', icon: Pencil, tooltip: 'Edit your comment', run: onEdit },
      {
        kind: 'action' as const, id: 'note.delete', label: 'Delete', icon: Trash2, tooltip: 'Delete your comment, for everyone',
        run: () => {
          const origin = currentOrigin();
          void confirmAction({ title: 'Delete this comment?', body: "It's deleted on the forge, for everyone.", confirmLabel: 'Delete', arm: 'Click again to delete the comment', danger: true }, origin).then((ok) => { if (ok) void deleteNote(tabId, number, d.id, n.id); });
        },
      },
    ] : []),
    ...(link ? [{ kind: 'action' as const, id: 'note.copyLink', label: 'Copy link', icon: Link, tooltip: `Copy ${link}`, run: () => copyLink(link) }] : []),
    { kind: 'action', id: 'note.quote', label: 'Quote reply', icon: Quote, tooltip: 'Quote this comment in a reply', run: () => { quoteReply(tabId, kind, number, d, n.body); } },
  ];
  return (
    <span className="mr-note-actions" data-open={picking || menuOpen || undefined}>
      {reactable && (
        <span className="mr-react">
          <HoverTooltip content="Add reaction">
            <button type="button" className="icon-button mr-note-btn" aria-label="Add reaction" aria-haspopup="dialog" aria-expanded={picking} onClick={() => setPicking((p) => !p)}><SmilePlus size={14} aria-hidden /></button>
          </HoverTooltip>
          {picking && <ReactionPicker kind={kind} mineOf={(name) => (n.reactions ?? []).some((r) => r.name === name && r.mine)} pick={(name) => void toggleReaction(tabId, number, d.id, n.id, name)} close={closePicker} />}
        </span>
      )}
      <button ref={more} type="button" className="icon-button mr-note-btn" aria-label="Comment actions" aria-haspopup="menu" onClick={() => { if (more.current) openMenuAt(more.current, rows(), undefined, rows, 'Comment actions'); }}><EllipsisVertical size={14} aria-hidden /></button>
    </span>
  );
}

/** A resolvable thread's Resolve / Unresolve, on its first comment's header: always shown; green
 * once resolved. */
export function ResolveButton({ tabId, number, d }: { tabId: string; number: number; d: ForgeDiscussion }) {
  const tip = d.resolved ? `Unresolve thread${d.resolvedBy ? ` · resolved by ${d.resolvedBy}` : ''}` : 'Resolve thread';
  return (
    <HoverTooltip content={tip}>
      <button type="button" className={`icon-button mr-note-btn mr-resolve${d.resolved ? ' on' : ''}`} aria-label={d.resolved ? 'Unresolve thread' : 'Resolve thread'} aria-pressed={d.resolved} onClick={() => void resolveThread(tabId, number, d.id, !d.resolved)}>
        <CircleCheck size={15} aria-hidden />
      </button>
    </HoverTooltip>
  );
}

/** A comment turned into its Markdown field (emoji and @ completion), with Cancel and Save.
 * Ctrl+Enter saves, Esc cancels. */
export function NoteEditor({ tabId, kind, number, d, n, onDone }: { tabId: string; kind: ForgeKind; number: number; d: ForgeDiscussion; n: ForgeNote; onDone: () => void }) {
  const [text, setText] = useState(n.body);
  const [busy, setBusy] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const ready = text.trim() !== '' && text !== n.body && !busy;
  // Esc inside the form cancels, as EditMr's: an Esc owner, after the field's emoji/@ list (it
  // re-registers each render, so it stays behind a list opened since).
  useEffect(() => {
    const own = (e: KeyboardEvent) => {
      const t = e.target instanceof Element ? e.target : null;
      if (!t || !form.current?.contains(t)) return false;
      onDone();
      return true;
    };
    escOwners.add(own);
    return () => { escOwners.delete(own); };
  });
  const save = async () => {
    if (!ready) return;
    setBusy(true);
    const ok = await saveNote(tabId, number, d.id, n.id, text);
    setBusy(false);
    if (ok) onDone();
  };
  return (
    <form ref={form} className="mr-reply mr-note-edit" aria-label="Edit comment" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <MarkdownField
        label="Edit comment"
        value={text}
        onChange={setText}
        flavor={kind}
        context={{ kind: 'forge', tabId }}
        autoFocus
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void save(); } }}
      />
      <div className="mr-form-row">
        <button type="button" className="mr-button" onClick={onDone}>Cancel</button>
        <button type="submit" className="mr-button primary" disabled={!ready}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </form>
  );
}

// Shown in the Keyboard Shortcuts panel (Ctrl+/); metadata only.
registerKeyHints([
  { id: 'key.mrNoteSave', section: 'Merge request', label: 'Save the edited comment', keys: ['Ctrl+Enter'], context: '(when editing a comment)', source: 'forge/mrview/NoteActions.tsx' },
  { id: 'key.mrNoteCancel', section: 'Merge request', label: 'Cancel the edit, or close the reaction picker', keys: ['Esc'], context: '(when editing a comment or picking a reaction)', source: 'forge/mrview/NoteActions.tsx' },
]);
