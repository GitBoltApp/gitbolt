import type { ForgeKind } from '../api/gen/ForgeKind';
import { forgePageOf } from '../markdown/links';

/**
 * "Go to what's on the clipboard" (Ctrl+V outside a text field): what the pasted text names.
 * Pure: `resolve.ts` finds it in the open tabs, `run.ts` goes there.
 */

/** Lines `start`–`end` (1-based, `start <= end`; one line: equal). */
export interface LineRange { start: number; end: number }

/** A forge page's project: its host (`host[:port]`, lower-case) and path (`group/sub/project`). */
export interface ForgeProjectRef { host: string; project: string; forge: ForgeKind }

export type GotoTarget =
  /** A commit by its hash (7–40 hex, lower-case). `ref`: the same text read as a ref name.
   * `loose`: all digits or all letters (a number, a word like `defaced`): not found, it's ignored. */
  | { kind: 'commit'; sha: string; ref: string | null; loose: boolean }
  /** An MR/PR: a forge URL (`at`), or `!12` / `#12` / `group/project!12` (`at` null, `sigil`). */
  | { kind: 'mr'; number: number; url: string | null; at: ForgeProjectRef | null; project: string | null; sigil: '!' | '#' | null }
  /** A forge commit page (an MR's commit too). */
  | { kind: 'forgeCommit'; sha: string; url: string; at: ForgeProjectRef }
  /** A forge file page: `refPath` is the ref and the path, decoded segments (a ref may have slashes). */
  | { kind: 'forgeFile'; refPath: string[]; lines: LineRange | null; url: string; at: ForgeProjectRef }
  /**
   * A file or folder. `path` uses `/`, without a trailing one; relative to the repo root unless
   * `absolute` (a Windows one keeps its drive, `C:/…`). `loose`: one relative name, no folder
   * (`README`, `notes:12`, `v1.2.3`), which could as well be any word: not found, it's ignored,
   * not reported. `ref`: the same text read as a ref name.
   */
  | { kind: 'path'; path: string; absolute: boolean; lines: LineRange | null; loose: boolean; ref: string | null }
  /** A branch, remote branch or tag name. */
  | { kind: 'ref'; name: string }
  | { kind: 'none' };

const NONE: GotoTarget = { kind: 'none' };
/** Longer text isn't something to go to (a pasted document). */
const MAX_TEXT = 4096;

const HASH = /^(?:commit\s+)?([0-9a-f]{7,40})(?:\s+\([^)]*\))?$/i;
const SHORT_MR = /^(?:([\w.-]+(?:\/[\w.-]+)+))?([!#])(\d+)$/;

/** What `text` names; the first non-empty line of several, if it names something on its own. */
export function classify(text: string): GotoTarget {
  if (text.length > MAX_TEXT) return NONE;
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '');
  return line === undefined ? NONE : classifyLine(line);
}

function classifyLine(s: string): GotoTarget {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return classifyUrl(s);
  // Another scheme (`mailto:`); not a drive letter (`C:`) nor a line (`Makefile:12`).
  if (/^[a-z][a-z0-9+.-]+:(?!\d)/i.test(s)) return NONE;
  const mr = SHORT_MR.exec(s);
  if (mr) return { kind: 'mr', number: Number(mr[3]), url: null, at: null, project: mr[1] ?? null, sigil: mr[2] as '!' | '#' };
  const hash = HASH.exec(s);
  if (hash) return { kind: 'commit', sha: hash[1].toLowerCase(), ref: refName(s), loose: /^(?:\d+|[a-f]+)$/i.test(hash[1]) };
  const path = classifyPath(s);
  if (path) return path;
  const ref = refName(s);
  return ref ? { kind: 'ref', name: ref } : NONE;
}

const decode = (s: string): string => { try { return decodeURIComponent(s); } catch { return s; } };

/** `#L12`, `#L12-20` (GitLab), `#L12-L20` (GitHub); reversed ranges are put in order. */
function anchorLines(hash: string): LineRange | null {
  const m = /^#L(\d+)(?:-L?(\d+))?$/i.exec(hash);
  return m ? range(m[1], m[2]) : null;
}

function range(a: string, b: string | undefined): LineRange | null {
  const start = Number(a);
  const end = b === undefined ? start : Number(b);
  if (!(start >= 1) || !(end >= 1)) return null;
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

function classifyUrl(s: string): GotoTarget {
  let u: URL;
  try { u = new URL(s); } catch { return NONE; }
  if (u.protocol === 'file:') {
    // file:///home/x/a.txt, file:///C:/x/a.txt
    const p = decode(u.pathname).replace(/^\/([a-z]:\/)/i, '$1');
    return classifyPath(p + u.hash) ?? NONE;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return NONE;
  const segs = u.pathname.split('/').filter(Boolean);
  // A GitLab page's project ends where `/-/` starts (projects nest in groups); a GitHub one is `owner/repo`.
  const dash = segs.indexOf('-');
  const forge: ForgeKind = dash > 0 ? 'gitlab' : 'github';
  const cut = dash > 0 ? dash : 2;
  if (segs.length <= cut) return NONE;
  const at: ForgeProjectRef = { host: u.host.toLowerCase(), project: segs.slice(0, cut).map(decode).join('/'), forge };
  const rest = segs.slice(cut).join('/');
  // An MR's own commit: GitLab's `…/merge_requests/12/diffs?commit_id=<sha>`, GitHub's `…/pull/12/commits/<sha>`.
  const inMr = forge === 'gitlab'
    ? (/^-\/merge_requests\/\d+(?:\/|$)/.test(rest) ? u.searchParams.get('commit_id') : null)
    : /^pull\/\d+\/commits\/([0-9a-f]{7,40})(?:\/|$)/i.exec(rest)?.[1] ?? null;
  if (inMr && /^[0-9a-f]{7,40}$/i.test(inMr)) return { kind: 'forgeCommit', sha: inMr.toLowerCase(), url: s, at };
  const page = forgePageOf(forge, rest);
  switch (page?.kind) {
    case 'mr': return { kind: 'mr', number: page.number, url: s, at, project: at.project, sigil: null };
    case 'commit': return { kind: 'forgeCommit', sha: page.sha, url: s, at };
    case 'blob': return { kind: 'forgeFile', refPath: page.refPath.split('/').map(decode), lines: anchorLines(u.hash), url: s, at };
    default: return NONE;
  }
}

const WINDOWS_ABS = /^(?:[a-z]:[\\/]|\\\\)/i;
/** `:12`, `:12-20`, `:12:5` (the column is ignored). */
const COLON_LINES = /:(\d+)(?:-(\d+)|:\d+)?$/;
const HASH_LINES = /#L\d+(?:-L?\d+)?$/i;

/** A path, with its lines; null when `s` can't be one. */
function classifyPath(s: string): Extract<GotoTarget, { kind: 'path' }> | null {
  let p = s;
  let lines: LineRange | null = null;
  const anchor = HASH_LINES.exec(p);
  if (anchor) {
    lines = anchorLines(anchor[0]);
    p = p.slice(0, anchor.index);
  } else {
    const colon = COLON_LINES.exec(p);
    if (colon) {
      lines = range(colon[1], colon[2]);
      p = p.slice(0, colon.index);
    }
  }
  if (p === '' || /[\0<>|"*?]/.test(p)) return null;
  const windows = WINDOWS_ABS.test(p);
  const absolute = windows || p.startsWith('/');
  if (windows || p.includes('\\')) p = p.replace(/\\/g, '/');
  // A relative path with spaces is more likely a sentence (an absolute one often has them).
  if (!absolute && /\s/.test(p)) return null;
  const normal = normalize(p, absolute);
  if (normal === null) return null;
  const ref = lines === null ? refName(s) : null;
  const loose = !absolute && !p.includes('/');
  return { kind: 'path', path: normal, absolute, lines, loose, ref };
}

/** `.` and `..` resolved, `//` and a trailing `/` dropped; null when a relative path climbs above its root. */
function normalize(p: string, absolute: boolean): string | null {
  const unc = p.startsWith('//');
  const drive = /^[a-z]:/i.exec(p)?.[0] ?? '';
  const body = p.slice(drive.length);
  const out: string[] = [];
  for (const seg of body.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) { if (absolute) continue; return null; }
      out.pop();
    } else out.push(seg);
  }
  if (!absolute) return out.length ? out.join('/') : null;
  if (drive) return `${drive.toUpperCase()}/${out.join('/')}`;
  return `${unc ? '//' : '/'}${out.join('/')}`;
}

/** `s` as a ref name (`git check-ref-format`'s rules, roughly), or null. */
function refName(s: string): string | null {
  if (s.length > 255 || /[\s~^:?*[\\\0]|\.\.|@\{|\/\/|^[-/.]|[/.]$|\.lock$|^@$/.test(s)) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(s)) return null;
  return s;
}
