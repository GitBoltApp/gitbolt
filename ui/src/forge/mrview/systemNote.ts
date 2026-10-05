/**
 * A forge's own note ("added 1 commit", "changed title from …") as structured parts. GitLab's
 * system notes arrive as Markdown with a little HTML (`<ul><li>`, `<code class="idiff">`, `&#39;`);
 * they are untrusted, so they are tokenized here into plain data and rendered as React text and
 * elements, never injected as HTML. Unknown tags are dropped (their text stays); a link is kept
 * only when it resolves to http(s).
 */

export type NoteCommit = { sha: string; subject: string };
export type NotePart =
  | { t: 'text'; text: string }
  | { t: 'code'; text: string }
  | { t: 'link'; text: string; url: string }
  | { t: 'del'; text: string }
  | { t: 'ins'; text: string }
  | { t: 'commits'; items: NoteCommit[]; more: number };

export type SystemKind = 'commits' | 'edit' | 'title' | 'mention' | 'approved' | 'unapproved' | 'merged' | 'closed' | 'reopened' | 'draft' | 'label' | 'other';

export interface SystemNote { kind: SystemKind; parts: NotePart[] }

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Decodes the HTML entities in text that is about to be shown as plain text (once, never nested). */
export function decodeEntities(s: string): string {
  return s.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z]+));/g, (m, dec?: string, hex?: string, name?: string) => {
    if (name) return ENTITIES[name] ?? m;
    const cp = dec ? parseInt(dec, 10) : parseInt(hex ?? '', 16);
    return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : m;
  });
}

/** An http(s) URL, or a `/path` resolved against the MR's web URL and staying on its origin;
 * anything else: null. Backslashes, control characters and whitespace are refused: URL parsing
 * treats a backslash as `/` and drops tabs and newlines, so `/\evil.example` would leave the host. */
export function safeUrl(raw: string, base: string): string | null {
  const url = decodeEntities(raw.trim());
  // eslint-disable-next-line no-control-regex
  if (/[\\\s\u0000-\u001f\u007f]/.test(url)) return null;
  try {
    let u: URL | null = null;
    if (/^https?:\/\//i.test(url)) u = new URL(url);
    else if (url.startsWith('/') && !url.startsWith('//')) {
      u = new URL(url, base);
      if (u.origin !== new URL(base).origin) return null;
    }
    return u && (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : null;
  } catch {
    return null;
  }
}

const SHA = '[0-9a-f]{7,40}(?:(?:…|\\.{3})[0-9a-f]{7,40})?';
const COMMIT_LINE = new RegExp(`^(${SHA}) - (.*)$`, 's');
const MD_COMMIT_BULLET = new RegExp(`^[ \\t]*[*-] (${SHA} - .*)$`, 'gm');

/** Every quantifier is bounded, and the body is capped (MAX_BODY), so no input costs more than
 * linear time in practice. */
const TOKEN = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]{0,200})>|\[([^\]\n]{0,300})\]\(([^)\s]{0,500})\)|\{-([^\n]{0,300}?)-\}|\{\+([^\n]{0,300}?)\+\}|`([^`\n]{1,200})`/g;
const MAX_BODY = 20_000;
export const MAX_COMMITS = 50;
const TITLE_MD = /^\s*changed title from \*\*([^\n]{0,500}?)\*\* to \*\*([^\n]{0,500}?)\*\*\s*$/;
const unmark = (t: string) => decodeEntities(t.replace(/\{[-+]|[-+]\}/g, ''));

const squash = (s: string) => s.replace(/\s+/g, ' ');

/** The kind of event, from what GitLab's text says. */
export function classify(text: string): SystemKind {
  const t = text.trim().toLowerCase();
  if (/^added \d+ commits?/.test(t)) return 'commits';
  if (/^changed title/.test(t)) return 'title';
  if (/^(changed|edited|updated) the description/.test(t) || /^description (changed|edited)/.test(t)) return 'edit';
  if (/^mentioned in/.test(t)) return 'mention';
  if (/^unapproved/.test(t) || /^requested changes/.test(t) || /^(removed|revoked) (their |an? )?approval/.test(t)) return 'unapproved';
  if (/^approved/.test(t)) return 'approved';
  if (/^merged\b/.test(t)) return 'merged';
  if (/^closed\b/.test(t)) return 'closed';
  if (/^reopened\b/.test(t)) return 'reopened';
  if (/^marked .*\b(draft|ready)\b/.test(t) || /^(set|removed) .*\bdraft\b/.test(t)) return 'draft';
  if (/\blabels?\b/.test(t)) return 'label';
  return 'other';
}

export function parseSystemNote(raw: string, baseUrl: string): SystemNote {
  const body = raw.length > MAX_BODY ? raw.slice(0, MAX_BODY) : raw;
  // GitLab's Markdown title change: the two bold groups are the whole old and new titles (its
  // `{-…-}` / `{+…+}` marks cover only the changed characters, so they are dropped).
  const title = TITLE_MD.exec(body);
  if (title) return { kind: 'title', parts: [{ t: 'text', text: 'changed title from ' }, { t: 'del', text: unmark(title[1] ?? '') }, { t: 'text', text: ' to ' }, { t: 'ins', text: unmark(title[2] ?? '') }] };
  const parts: NotePart[] = [];
  const noLinks = /^\s*changed title/i.test(body); // a title's text is never a link
  const src = body.replace(/\*\*/g, '').replace(MD_COMMIT_BULLET, '<li>$1</li>');
  let li: string | null = null; // the text of the open <li>
  let cap: { idiff: boolean; text: string } | null = null; // an open <code>
  let idiffs = 0;
  const addText = (t: string) => {
    if (!t) return;
    if (cap) cap.text += t;
    else if (li !== null) li += t;
    else if (t.trim() === '' && parts[parts.length - 1]?.t === 'commits') return; // the gap after a list
    else parts.push({ t: 'text', text: t });
  };
  const flushLi = () => {
    if (li === null) return;
    const text = squash(li).trim();
    li = null;
    if (!text) return;
    const m = COMMIT_LINE.exec(text);
    const item: NoteCommit = m ? { sha: m[1] ?? '', subject: m[2] ?? '' } : { sha: '', subject: text };
    const last = parts[parts.length - 1];
    const list = last?.t === 'commits' ? last : null;
    if (list) { if (list.items.length < MAX_COMMITS) list.items.push(item); else list.more++; }
    else parts.push({ t: 'commits', items: [item], more: 0 });
  };
  let at = 0;
  for (const m of src.matchAll(TOKEN)) {
    const start = m.index ?? 0;
    addText(decodeEntities(squash(src.slice(at, start))));
    at = start + m[0].length;
    if (m[2] !== undefined) {
      const tag = m[2].toLowerCase();
      const closing = m[1] === '/';
      if (tag === 'li') {
        flushLi();
        if (!closing) li = '';
      } else if (tag === 'ul' || tag === 'ol') flushLi();
      else if (tag === 'code' && !closing) cap = { idiff: /\bidiff\b/.test(m[3] ?? ''), text: '' };
      else if (tag === 'code' && cap) {
        const done = cap;
        cap = null;
        if (done.idiff) { if (done.text) parts.push({ t: idiffs++ === 0 ? 'del' : 'ins', text: done.text }); }
        else if (li !== null) li += done.text;
        else if (done.text) parts.push({ t: 'code', text: done.text });
      } else if (tag === 'br') addText(' ');
      // Every other tag (span, p, a, strong, script, …) is dropped; its text stays.
    } else if (m[5] !== undefined) {
      const text = decodeEntities(m[4] ?? '');
      const url = safeUrl(m[5], baseUrl);
      if (url && !noLinks && !cap && li === null) parts.push({ t: 'link', text: text || url, url });
      else addText(text);
    } else if (m[8] !== undefined) {
      if (cap || li !== null) addText(decodeEntities(m[8]));
      else parts.push({ t: 'code', text: decodeEntities(m[8]) });
    } else if (m[6] !== undefined) {
      parts.push({ t: 'del', text: decodeEntities(m[6]) });
    } else if (m[7] !== undefined) {
      parts.push({ t: 'ins', text: decodeEntities(m[7]) });
    }
  }
  addText(decodeEntities(squash(src.slice(at))));
  if (cap) { const rest: string = (cap as { text: string }).text; cap = null; if (rest) parts.push({ t: 'text', text: rest }); }
  flushLi();
  // Trim the outer whitespace of the first and last text parts.
  const first = parts[0];
  if (first?.t === 'text') first.text = first.text.replace(/^\s+/, '');
  const last = parts[parts.length - 1];
  if (last?.t === 'text') last.text = last.text.replace(/\s+$/, '');
  const clean = parts.filter((p) => p.t !== 'text' || p.text !== '');
  const lead = clean.map((p) => (p.t === 'text' ? p.text : p.t === 'code' ? p.text : '')).join('');
  return { kind: classify(lead), parts: clean };
}
