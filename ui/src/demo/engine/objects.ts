// Commit and tag objects as the core reads them (commit::parse_commit and parse_signature,
// refs::read_tag and annotation_of, shelldata::subject), from the raw bytes of an object.
import type { TagAnnotation } from '../../api/gen/TagAnnotation';
import type { CommitIn } from '../gen/CommitIn';
import { gbError } from './errors';

export const TAG_MESSAGE_LINES = 10;
const TAG_MESSAGE_CHARS = 2000;

const LF = 0x0a;
const CR = 0x0d;
const SP = 0x20;

/** Rust's `char::is_whitespace` (Unicode White_Space): JS's `trim` also strips U+FEFF, which a BOM
 * must not lose. */
const RUST_WS = '\\t\\n\\u000b\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const LEADING_WS = new RegExp(`^[${RUST_WS}]+`);
const TRAILING_WS = new RegExp(`[${RUST_WS}]+$`);
export const trimRust = (s: string): string => s.replace(LEADING_WS, '').replace(TRAILING_WS, '');
export const trimEndRust = (s: string): string => s.replace(TRAILING_WS, '');

/** UTF-8 when valid (a BOM kept), otherwise Latin-1, which maps every byte (commit::decode_text). */
export function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return latin1(bytes);
  }
}

/** Bytes as a Latin-1 string, one char per byte (chunked, so a large blob is not one spread call). */
export function latin1(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return out;
}

/** Tag text is read lossily as UTF-8 (gix's `to_str_lossy`), a BOM kept. */
export function lossyUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
}

/** A commit's text in its `encoding` header's charset (commit::decode_with): UTF-8 as decodeText;
 * another label through the browser's decoder; the replacement encoding, UTF-16 and unknown labels
 * as Latin-1, which can't fail. */
export function decodeWith(encoding: string | null, bytes: Uint8Array): string {
  if (encoding === null) return decodeText(bytes);
  const label = encoding.toLowerCase();
  if (label === 'utf-8' || label === 'utf8') return decodeText(bytes);
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(label.trim(), { ignoreBOM: true });
  } catch {
    return latin1(bytes);
  }
  if (decoder.encoding === 'replacement' || decoder.encoding.startsWith('utf-16')) return latin1(bytes);
  return decoder.decode(bytes);
}

/** An author, committer or tagger line: the name before the last `<`, the email up to the last
 * `>`, then the time (0 when it isn't a number). */
export function parseSignature(text: string): { name: string; email: string; time: number } {
  const lt = text.lastIndexOf('<');
  const gt = text.lastIndexOf('>');
  if (lt < 0 || gt < 0) return { name: trimRust(text), email: '', time: 0 };
  const word = trimRust(text.slice(gt + 1)).split(/\s+/)[0] ?? '';
  // A time git can't hold in an i64 (or past 2^53, where JS numbers lose digits) reads as 0.
  const time = Number(word);
  return { name: trimRust(text.slice(0, lt)), email: text.slice(lt + 1, Math.max(gt, lt + 1)), time: /^[+-]?\d+$/.test(word) && Number.isSafeInteger(time) ? time : 0 };
}

/** The index of the first blank line's first newline, or -1 (the headers end there). */
function indexOfBlankLine(bytes: Uint8Array): number {
  for (let i = 0; i + 1 < bytes.length; i++) if (bytes[i] === LF && bytes[i + 1] === LF) return i;
  return -1;
}

function linesOf(bytes: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  let start = 0;
  for (let i = 0; i <= bytes.length; i++) {
    if (i === bytes.length || bytes[i] === LF) {
      out.push(bytes.subarray(start, i));
      start = i + 1;
    }
  }
  return out;
}

/** A commit object's headers, read as bytes (commit::parse_commit): the author and committer
 * lines stay raw, so a name in a legacy `encoding` decodes with it wherever that header sits. */
export interface CommitHeaders {
  tree: string;
  parents: string[];
  author: Uint8Array;
  committer: Uint8Array;
  encoding: string | null;
  /** A `gpgsig` or `gpgsig-sha256` header. */
  signed: boolean;
  /** Everything past the first blank line. */
  messageBytes: Uint8Array;
}

export function readCommitHeaders(raw: Uint8Array): CommitHeaders {
  const split = indexOfBlankLine(raw);
  const headers = split < 0 ? raw : raw.subarray(0, split);
  const out: CommitHeaders = { tree: '', parents: [], author: new Uint8Array(0), committer: new Uint8Array(0), encoding: null, signed: false, messageBytes: split < 0 ? new Uint8Array(0) : raw.subarray(split + 2) };
  for (const full of linesOf(headers)) {
    const line = full.length > 0 && full[full.length - 1] === CR ? full.subarray(0, -1) : full;
    if (line[0] === SP) continue; // a continuation line of a multi-line header (gpgsig, mergetag)
    const sp = line.indexOf(SP);
    const key = latin1(sp < 0 ? line : line.subarray(0, sp));
    const value = sp < 0 ? new Uint8Array(0) : line.subarray(sp + 1);
    if (key === 'tree') out.tree = latin1(value).toLowerCase();
    else if (key === 'parent') {
      const oid = latin1(value);
      if (!/^[0-9a-fA-F]{40}$/.test(oid)) throw gbError('Other', `bad parent id in commit: ${oid}`);
      out.parents.push(oid.toLowerCase());
    } else if (key === 'author') out.author = value;
    else if (key === 'committer') out.committer = value;
    else if (key === 'encoding') out.encoding = decodeText(value);
    else if (key === 'gpgsig' || key === 'gpgsig-sha256') out.signed = true;
  }
  return out;
}

/** A commit object: its parents, author, committer time and whole message (the graph crate
 * splits the message, as the core does). */
export function parseCommitObject(id: string, raw: Uint8Array): CommitIn {
  const h = readCommitHeaders(raw);
  const a = parseSignature(decodeWith(h.encoding, h.author));
  const c = parseSignature(decodeWith(h.encoding, h.committer));
  return { id, parents: h.parents, authorName: a.name, authorEmail: a.email, authorTime: a.time, committerTime: c.time, message: decodeWith(h.encoding, h.messageBytes) };
}

export interface TagObject { object: string; type: string; tagger: { name: string; time: number } | null; message: string }

/** Where the last signature armor starts at a line of `message` (gix's `signature::find`), or -1. */
function signatureStart(message: string): number {
  let at = -1;
  for (const m of message.matchAll(/-----BEGIN (?:PGP (?:SIGNATURE|MESSAGE)|SIGNED MESSAGE|SSH SIGNATURE)-----/g)) {
    if (m.index === 0 || message[m.index - 1] === '\n') at = m.index;
  }
  return at;
}

/** A tag object, its signature left out of the message. */
export function parseTagObject(raw: Uint8Array): TagObject {
  const text = lossyUtf8(raw);
  const split = text.indexOf('\n\n');
  const headers = split < 0 ? text : text.slice(0, split);
  let message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tagger: TagObject['tagger'] = null;
  for (const line of headers.split('\n')) {
    const sp = line.indexOf(' ');
    const key = sp < 0 ? line : line.slice(0, sp);
    const value = sp < 0 ? '' : line.slice(sp + 1);
    if (key === 'object') object = trimRust(value);
    else if (key === 'type') type = trimRust(value);
    else if (key === 'tagger') {
      const s = parseSignature(value);
      tagger = { name: s.name, time: s.time };
    }
  }
  const sig = signatureStart(message);
  if (sig >= 0) message = message.slice(0, sig);
  return { object, type, tagger, message };
}

/** The tooltip's part of an annotated tag (refs::annotation_of). */
export function annotationOf(tag: TagObject): TagAnnotation {
  const lines = trimRust(tag.message).split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  let message = lines.slice(0, TAG_MESSAGE_LINES).join('\n').replace(TRAILING_WS, '');
  let truncated = lines.slice(TAG_MESSAGE_LINES).some((l) => trimRust(l) !== '');
  const chars = [...message];
  if (chars.length > TAG_MESSAGE_CHARS) {
    message = chars.slice(0, TAG_MESSAGE_CHARS).join('');
    truncated = true;
  }
  const name = trimRust(tag.tagger?.name ?? '');
  return { message, truncated, tagger: name === '' ? null : name, time: tag.tagger?.time ?? 0 };
}

/** `%(subject)`: the message's first paragraph (past leading empty lines), its lines joined with
 * spaces, a CR before each LF dropped (shelldata::subject). */
export function subject(message: string): string {
  const m = message.replace(/^\n+/, '');
  const ends = [m.indexOf('\n\n'), m.indexOf('\r\n\r\n')].filter((i) => i >= 0);
  return m.slice(0, ends.length ? Math.min(...ends) : m.length).replace(/[\r\n]+$/, '').replace(/\r?\n/g, ' ');
}
