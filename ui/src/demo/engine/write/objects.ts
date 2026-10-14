// The objects every write makes, written by hand so their bytes, and so their ids, are git's: trees
// in git's entry order, commits and annotated tags with their headers and message as given. The
// identity is always the visitor's (the interfaces doc), at the demo's clock.
import * as git from 'isomorphic-git';
import type { DemoClock } from '../../context';
import { readCommitHeaders } from '../objects';
import { compareBytewise, utf8Bytes } from '../read/bytes';
import type { IndexEntry } from '../read/indexFile';
import { fail, igNoCache, type ReadRepo } from '../read/seam';
import { isTreeMode, MODE_TREE, readRaw } from '../read/trees';

export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
export const EMPTY_BLOB = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';
export const DEMO_IDENTITY = { name: 'You', email: 'you@example.com' } as const;

function tz(minutes: number): string {
  const m = Math.abs(minutes);
  return `${minutes < 0 ? '-' : '+'}${String(Math.floor(m / 60)).padStart(2, '0')}${String(m % 60).padStart(2, '0')}`;
}

/** An author, committer or tagger line's value: `Name <email> <seconds> <+hhmm>`. */
export const identLine = (name: string, email: string, seconds: number, tzMinutes: number): string => `${name} <${email}> ${seconds} ${tz(tzMinutes)}`;

/** The visitor, now. */
export const demoIdent = (clock: DemoClock): string => identLine(DEMO_IDENTITY.name, DEMO_IDENTITY.email, Math.floor(clock.nowMs() / 1000), clock.tzOffsetMinutes());

export async function writeRawObject(repo: ReadRepo, type: 'blob' | 'tree' | 'commit' | 'tag', object: Uint8Array): Promise<string> {
  return git.writeObject({ ...igNoCache(repo), type, object, format: 'content' });
}

export const writeBlobBytes = (repo: ReadRepo, bytes: Uint8Array): Promise<string> => writeRawObject(repo, 'blob', bytes);

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const idBytes = (hex: string) => Uint8Array.from({ length: 20 }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16));

/** A tree object's bytes: `<octal mode> <name>\0<20-byte id>` per entry, in git's order (a folder
 *  sorts as if its name ended in `/`, so `a-b` comes before the folder `a`). */
export function treeBytes(items: { name: string; mode: number; oid: string }[]): Uint8Array {
  const key = (i: { name: string; mode: number }) => (isTreeMode(i.mode) ? `${i.name}/` : i.name);
  const sorted = [...items].sort((a, b) => compareBytewise(key(a), key(b)));
  return concat(sorted.flatMap((i) => [utf8Bytes(`${i.mode.toString(8)} ${i.name}\0`), idBytes(i.oid)]));
}

interface Dir {
  files: { name: string; mode: number; oid: string }[];
  dirs: Map<string, Dir>;
}

/** The tree holding `files` (paths with their mode and blob), its subtrees written first; its id. */
export async function writeTreeOf(repo: ReadRepo, files: Iterable<{ path: string; mode: number; oid: string }>): Promise<string> {
  const root: Dir = { files: [], dirs: new Map() };
  for (const f of files) {
    const parts = f.path.split('/');
    let d = root;
    for (const p of parts.slice(0, -1)) {
      let next = d.dirs.get(p);
      if (!next) d.dirs.set(p, (next = { files: [], dirs: new Map() }));
      d = next;
    }
    d.files.push({ name: parts[parts.length - 1], mode: f.mode, oid: f.oid });
  }
  const write = async (d: Dir): Promise<string> => {
    const items = [...d.files];
    for (const [name, sub] of d.dirs) items.push({ name, mode: MODE_TREE, oid: await write(sub) });
    return writeRawObject(repo, 'tree', treeBytes(items));
  };
  return write(root);
}

/** `git write-tree`: the index's stage-0 entries as a tree, intent-to-add ones left out; an
 *  unmerged path refuses as git does. */
export async function writeIndexTree(repo: ReadRepo, entries: IndexEntry[]): Promise<string> {
  if (entries.some((e) => e.stage !== 0)) fail('Conflict', 'you need to resolve your current index first');
  return writeTreeOf(repo, entries.filter((e) => !e.intentToAdd));
}

export interface CommitSpec {
  tree: string;
  parents: string[];
  /** Signature lines' values (`identLine`, or an amended commit's own author). */
  author: string;
  committer: string;
  /** As stored: cleaned by the caller. */
  message: string;
}

export async function writeCommitObject(repo: ReadRepo, c: CommitSpec): Promise<string> {
  const head = [`tree ${c.tree}`, ...c.parents.map((p) => `parent ${p}`), `author ${c.author}`, `committer ${c.committer}`].join('\n');
  return writeRawObject(repo, 'commit', utf8Bytes(`${head}\n\n${c.message}`));
}

export async function writeTagObject(repo: ReadRepo, t: { object: string; name: string; tagger: string; message: string }): Promise<string> {
  return writeRawObject(repo, 'tag', utf8Bytes(`object ${t.object}\ntype commit\ntag ${t.name}\ntagger ${t.tagger}\n\n${t.message}`));
}

/** A commit's author line as stored (an amend keeps it, time zone and all). */
export async function rawAuthor(repo: ReadRepo, commit: string): Promise<string> {
  const raw = await readRaw(repo, commit);
  if (raw?.type !== 'commit') fail('NotFound', `no such commit: ${commit}`);
  return new TextDecoder().decode(readCommitHeaders(raw.bytes).author);
}

/** git's `whitespace` cleanup (`commit -F`): trailing whitespace off every line (a CR included), runs
 *  of blank lines down to one, leading and trailing blank lines gone, a final newline; empty stays empty. */
export function cleanupWhitespace(message: string): string {
  const out: string[] = [];
  let blank = false;
  for (const raw of message.split('\n')) {
    const line = raw.replace(/[ \t\r\n]+$/, '');
    if (line === '') {
      blank = out.length > 0;
      continue;
    }
    if (blank) out.push('');
    blank = false;
    out.push(line);
  }
  return out.length === 0 ? '' : `${out.join('\n')}\n`;
}

/** git's `strip` cleanup (`tag -F`): `whitespace`, with lines starting with `#` dropped first. */
export const cleanupStrip = (message: string): string => cleanupWhitespace(message.split('\n').filter((l) => !l.startsWith('#')).join('\n'));
