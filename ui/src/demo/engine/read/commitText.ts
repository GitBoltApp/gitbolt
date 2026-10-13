import type { CoAuthor } from '../../../api/gen/CoAuthor';
import type { CommitMessage } from '../../../api/gen/CommitMessage';
import { decodeWith, parseSignature, readCommitHeaders, trimEndRust, trimRust } from '../objects';
import { readRaw } from './trees';
import { fail, type ReadRepo } from './seam';

export interface Person {
  name: string;
  email: string;
  /** Unix seconds, or 0 when the signature line's time doesn't parse. */
  time: number;
}

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: Person;
  committer: Person;
  summary: string;
  body: string;
  /** Decoded, CRLF normalised to LF, trailing whitespace trimmed. */
  message: string;
  /** Decoded, as stored (git's `%s` and blame's summary read this). */
  rawMessage: string;
  signed: boolean;
}

/** An author or committer line, decoded in the commit's `encoding`, read by 1a's `parseSignature`. */
function signature(raw: Uint8Array, encoding: string | null): Person {
  return parseSignature(decodeWith(encoding, raw));
}

export function parseCommit(raw: Uint8Array): ParsedCommit {
  const h = readCommitHeaders(raw);
  const rawMessage = decodeWith(h.encoding, h.messageBytes);
  const message = trimEndRust(rawMessage.replaceAll('\r\n', '\n'));
  const para = message.indexOf('\n\n');
  const first = para < 0 ? message : message.slice(0, para);
  const body = para < 0 ? '' : trimRust(message.slice(para + 2));
  const summary = trimRust(first.split('\n')[0] ?? '');
  return { tree: h.tree, parents: h.parents, author: signature(h.author, h.encoding), committer: signature(h.committer, h.encoding), summary, body, message, rawMessage, signed: h.signed };
}

/** A full 40-hex id sent by the UI; anything else (an abbreviation, `--option`) is refused. */
export function parseOid(s: string): string {
  if (!/^[0-9a-fA-F]{40}$/.test(s)) fail('InvalidInput', `not a full object id: ${JSON.stringify(s)}`);
  return s.toLowerCase();
}

export async function readCommit(repo: ReadRepo, oid: string): Promise<ParsedCommit> {
  const key = `commit:${oid}`;
  const hit = repo.memo.get(key) as ParsedCommit | undefined;
  if (hit) return hit;
  const obj = await readRaw(repo, oid);
  if (!obj) fail('NotFound', `no such commit: ${oid}`);
  if (obj.type !== 'commit') fail('InvalidInput', `not a commit: ${oid}`);
  const parsed = parseCommit(obj.bytes);
  repo.memo.set(key, parsed);
  return parsed;
}

export async function readCommitOrNull(repo: ReadRepo, oid: string): Promise<ParsedCommit | null> {
  try {
    return await readCommit(repo, oid);
  } catch {
    return null;
  }
}

/** The core's `read_commit_message`: everything after the first line, trimmed, is the body. */
export function commitMessage(c: ParsedCommit, id: string): CommitMessage {
  const nl = c.message.indexOf('\n');
  return { id: id.toLowerCase(), summary: c.summary, body: nl < 0 ? '' : trimRust(c.message.slice(nl + 1)) };
}

const CO_AUTHOR = /^[ \t]*co-authored-by:[ \t]*(.*?)[ \t]*<([^<>\s]+)>[ \t]*$/gim;

export function coAuthors(message: string): CoAuthor[] {
  const seen = new Set<string>();
  const out: CoAuthor[] = [];
  for (const m of message.matchAll(CO_AUTHOR)) {
    const key = m[2].replace(/[A-Z]/g, (c) => c.toLowerCase());
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: trimRust(m[1]), email: m[2] });
  }
  return out;
}

const BLANK = /^[ \t\n\v\f\r]*$/;

/** git's `%s`, not 1a's `subject()` (the sidebar's): also skips leading blank lines and trims each line's trailing whitespace. */
export function gitSubject(rawMessage: string): string {
  const lines = rawMessage.split('\n');
  let i = 0;
  while (i < lines.length && BLANK.test(lines[i])) i++;
  const parts: string[] = [];
  for (; i < lines.length; i++) {
    const line = lines[i].replace(/[ \t\n\v\f\r]+$/, '');
    if (line === '') break;
    parts.push(line);
  }
  return parts.join(' ');
}

/** `git blame --porcelain`'s `summary`: the first non-blank line as it is, or `(<sha>)`. */
export function blameSummary(rawMessage: string, id: string): string {
  const lines = rawMessage.split('\n');
  const line = lines.find((l) => !BLANK.test(l)) ?? '';
  return line === '' ? `(${id})` : line;
}
