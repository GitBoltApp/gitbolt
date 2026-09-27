import { issueUrl, mergeRequestUrl, projectRemote, type ProjectRemote } from '../forge/urls';

export { projectRemote, type ProjectRemote };

export interface ForgeRef {
  type: 'mr' | 'issue';
  project: string | null;
  number: number;
  label: string;
}

export type MessageToken = { kind: 'text'; text: string } | { kind: 'link'; text: string; url: string; ref: ForgeRef | null };

/** At most this many labels, mirroring `MAX_MESSAGE_REFS` (`gitbolt-core/src/message_refs.rs`), so
 * a pathological message can't blow up `referenceLabels`. */
const MAX_MESSAGE_REFS = 20;

/** A Unicode "word" character: letters, numbers or underscore (spec §9.2). Must use `\p{L}\p{N}`,
 * not ASCII `\w`, to match the Rust parser's `char::is_alphanumeric`. */
function isWordChar(c: string): boolean {
  return /^[\p{L}\p{N}_]$/u.test(c);
}

/** A path-segment byte: ASCII alphanumeric, `_`, `.`, `-` or the `/` separator. ASCII-only,
 * matching the Rust parser's byte-wise `is_path_byte`. */
function isPathByte(c: string): boolean {
  return /^[A-Za-z0-9_.\-/]$/.test(c);
}

/** `segment/…/segment`: at least two non-empty segments. */
function isPath(p: string): boolean {
  const segments = p.split('/');
  return segments.length >= 2 && segments.every((s) => s.length > 0);
}

function isUrlStart(rest: string): boolean {
  const start = rest.slice(0, 8).toLowerCase();
  return start.startsWith('http://') || start.startsWith('https://');
}

/** A character glued to a reference: a word character, or one of `/ . ! # -`. A reference right
 * after one of these isn't a reference (`C#123`, `abc!4`). */
function isGlued(c: string): boolean {
  return isWordChar(c) || c === '/' || c === '.' || c === '!' || c === '#' || c === '-';
}

/** The `[start, end)` span of the reference whose `!`/`#` sits at `sigil`, if there is one. A
 * direct, character-wise port of `reference_at` in `gitbolt-core/src/message_refs.rs` — see that
 * file for the reasoning behind each check. */
function referenceAt(message: string, sigil: number): [number, number] | null {
  const digitsStart = sigil + 1;
  let end = digitsStart;
  while (end < message.length && message[end] >= '0' && message[end] <= '9') end++;
  if (end === digitsStart) return null;
  if (end < message.length && isWordChar(message[end])) return null;
  let start = sigil;
  while (start > 0 && isPathByte(message[start - 1])) start--;
  if (start < sigil && !isPath(message.slice(start, sigil))) return null;
  if (start > 0 && isGlued(message[start - 1])) return null;
  return [start, end];
}

/** Every `!N`, `path!N`, `#N` and `path#N` reference in `message`, exactly as written, in
 * first-occurrence order, deduplicated, capped at `MAX_MESSAGE_REFS`. The host kind isn't
 * involved: this mirrors `parse_message_refs` (`gitbolt-core/src/message_refs.rs`) byte-for-byte,
 * and is pinned against the same shared vectors (`testdata/message-refs.json`). */
export function referenceLabels(message: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < message.length && out.length < MAX_MESSAGE_REFS) {
    const c = message[i];
    if ((c === 'h' || c === 'H') && isUrlStart(message.slice(i))) {
      const ws = /\s/.exec(message.slice(i));
      i = ws ? i + ws.index : message.length;
      continue;
    }
    if (c === '!' || c === '#') {
      const ref = referenceAt(message, i);
      if (ref) {
        const [start, end] = ref;
        const label = message.slice(start, end);
        if (!out.includes(label)) out.push(label);
        i = end;
      } else {
        i++;
      }
      continue;
    }
    i++;
  }
  return out;
}

/** Trailing punctuation excluded from a linked URL (spec §9.2): a run of these right before the
 * end of the URL's whitespace-delimited span is not part of the link. */
const TRAILING_PUNCTUATION = /[.,;:!?)\]]/;

function buildRefToken(label: string, sigil: '!' | '#', remote: ProjectRemote): MessageToken | null {
  const idx = label.indexOf(sigil);
  const project = idx > 0 ? label.slice(0, idx) : null;
  const n = Number(label.slice(idx + 1));
  if (sigil === '!') {
    const url = remote.hostKind === 'gitlab' ? mergeRequestUrl(remote, project, n) : null;
    return url ? { kind: 'link', text: label, url, ref: { type: 'mr', project, number: n, label } } : null;
  }
  // `#`: GitLab issues, GitHub pull requests (both get an "Open" button; spec §9.2).
  if (remote.hostKind === 'gitlab') {
    const url = issueUrl(remote, project, n);
    return url ? { kind: 'link', text: label, url, ref: { type: 'issue', project, number: n, label } } : null;
  }
  if (remote.hostKind === 'github') {
    const url = mergeRequestUrl(remote, project, n);
    return url ? { kind: 'link', text: label, url, ref: { type: 'mr', project, number: n, label } } : null;
  }
  return null;
}

/** Splits a message into text and links (spec §9.2): URLs always link; `!`/`#` references link
 * per host kind (GitLab: `!` MRs, `#` issues; GitHub: `#` PRs, `!` ignored; generic or no remote:
 * URLs only). Concatenating every token's text gives back the input exactly. */
export function tokenizeMessage(text: string, remote: ProjectRemote | null): MessageToken[] {
  const out: MessageToken[] = [];
  let last = 0;
  let i = 0;
  const pushText = (s: string) => {
    if (s) out.push({ kind: 'text', text: s });
  };
  while (i < text.length) {
    const c = text[i];
    if ((c === 'h' || c === 'H') && isUrlStart(text.slice(i))) {
      const ws = /\s/.exec(text.slice(i));
      const skipEnd = ws ? i + ws.index : text.length;
      let urlEnd = skipEnd;
      while (urlEnd > i && TRAILING_PUNCTUATION.test(text[urlEnd - 1])) urlEnd--;
      if (urlEnd > i) {
        const url = text.slice(i, urlEnd);
        pushText(text.slice(last, i));
        out.push({ kind: 'link', text: url, url, ref: null });
        last = urlEnd;
      }
      i = skipEnd;
      continue;
    }
    if (c === '!' || c === '#') {
      const ref = referenceAt(text, i);
      if (ref) {
        const [start, end] = ref;
        const token = remote ? buildRefToken(text.slice(start, end), c, remote) : null;
        if (token) {
          pushText(text.slice(last, start));
          out.push(token);
          last = end;
        }
        i = end;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  pushText(text.slice(last));
  return out;
}

/** One `Open !1187` button per distinct MR/PR reference (spec §9.2). */
export function mergeRequestButtons(tokens: MessageToken[]): { label: string; url: string }[] {
  const seen = new Set<string>();
  const out: { label: string; url: string }[] = [];
  for (const t of tokens) {
    if (t.kind === 'link' && t.ref?.type === 'mr' && !seen.has(t.url)) {
      seen.add(t.url);
      out.push({ label: `Open ${t.ref.label}`, url: t.url });
    }
  }
  return out;
}
