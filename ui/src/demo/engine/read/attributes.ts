import { lossyUtf8 } from './bytes';
import { readIndex } from './indexFile';
import { readBlobBytes } from './trees';
import { readTextOrNull, type ReadRepo } from './seam';
import { worktreeOf } from './worktrees';

export type AttrValue = true | false | string;
export type Attrs = Map<string, AttrValue>;
interface Rule {
  re: RegExp;
  attrs: [string, AttrValue | null][];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** A `.gitattributes` pattern in folder `dir` ('' for the root) as a regular expression on full paths. */
export function globToRegExp(pattern: string, dir: string): RegExp | null {
  if (pattern === '' || pattern.endsWith('/')) return null;
  const anchored = pattern.includes('/');
  const p = pattern.startsWith('/') ? pattern.slice(1) : pattern;
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        const atStart = i === 0 || p[i - 1] === '/';
        if (atStart && p[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
          continue;
        }
        if (atStart && i + 2 === p.length) {
          re += '.*';
          i += 1;
          continue;
        }
        i += 1;
      }
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '[') {
      const close = p.indexOf(']', i + 2);
      if (close < 0) {
        re += '\\[';
        continue;
      }
      let body = p.slice(i + 1, close);
      const negate = body.startsWith('!') || body.startsWith('^');
      if (negate) body = body.slice(1);
      re += `[${negate ? '^/' : ''}${body.replace(/\\/g, '\\\\').replace(/\^/g, '\\^')}]`;
      i = close;
    } else if (c === '\\' && i + 1 < p.length) {
      i += 1;
      re += escapeRe(p[i]);
    } else {
      re += escapeRe(c);
    }
  }
  const prefix = dir ? escapeRe(`${dir}/`) : '';
  return new RegExp(anchored ? `^${prefix}${re}$` : `^${prefix}(?:.*/)?${re}$`);
}

const MACROS: Record<string, [string, AttrValue][]> = { binary: [['binary', true], ['diff', false], ['merge', false], ['text', false]] };

export function parseAttributes(text: string, dir: string): Rule[] {
  const rules: Rule[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const [pattern, ...tokens] = line.split(/\s+/);
    if (pattern.startsWith('!') || pattern.startsWith('[attr]')) continue;
    const re = globToRegExp(pattern, dir);
    if (!re) continue;
    const attrs: [string, AttrValue | null][] = [];
    for (const tok of tokens) {
      if (tok.startsWith('-')) attrs.push([tok.slice(1), false]);
      else if (tok.startsWith('!')) attrs.push([tok.slice(1), null]);
      else if (tok.includes('=')) attrs.push([tok.slice(0, tok.indexOf('=')), tok.slice(tok.indexOf('=') + 1)]);
      else if (MACROS[tok]) attrs.push(...MACROS[tok]);
      else attrs.push([tok, true]);
    }
    rules.push({ re, attrs });
  }
  return rules;
}

/** The attributes of paths in one worktree; parsed files are kept for this reader's life (one request). */
export class AttrReader {
  private readonly files = new Map<string, Promise<Rule[]>>();
  private index: Promise<Map<string, string>> | null = null;
  private readonly repo: ReadRepo;
  private readonly root: string;

  constructor(repo: ReadRepo, root: string) {
    this.repo = repo;
    this.root = root;
  }

  async get(path: string): Promise<Attrs> {
    const parts = path.split('/');
    const dirs = [''];
    for (let i = 1; i < parts.length; i++) dirs.push(parts.slice(0, i).join('/'));
    const out: Attrs = new Map();
    const apply = (rules: Rule[]) => {
      for (const r of rules) {
        if (!r.re.test(path)) continue;
        for (const [name, v] of r.attrs) {
          if (v === null) out.delete(name);
          else out.set(name, v);
        }
      }
    };
    for (const d of dirs) apply(await this.rulesIn(d));
    apply(await this.infoRules());
    return out;
  }

  private rulesIn(dir: string): Promise<Rule[]> {
    let hit = this.files.get(dir);
    if (!hit) {
      hit = (async () => {
        const rel = dir ? `${dir}/.gitattributes` : '.gitattributes';
        let text = await readTextOrNull(this.repo, `${this.root}/${rel}`);
        if (text === null) {
          const oid = (await this.indexed()).get(rel);
          text = oid ? lossyUtf8(await readBlobBytes(this.repo, oid)) : null;
        }
        return text === null ? [] : parseAttributes(text, dir);
      })();
      this.files.set(dir, hit);
    }
    return hit;
  }

  private infoRules(): Promise<Rule[]> {
    let hit = this.files.get('\0info');
    if (!hit) {
      hit = readTextOrNull(this.repo, `${this.repo.gitdir}/info/attributes`).then((t) => (t === null ? [] : parseAttributes(t, '')));
      this.files.set('\0info', hit);
    }
    return hit;
  }

  private indexed(): Promise<Map<string, string>> {
    this.index ??= (async () => {
      const wt = await worktreeOf(this.repo, this.root);
      const out = new Map<string, string>();
      for (const e of await readIndex(this.repo, wt.gitdir)) if (e.stage === 0 && (e.path === '.gitattributes' || e.path.endsWith('/.gitattributes'))) out.set(e.path, e.oid);
      return out;
    })();
    return this.index;
  }
}

export function worktreeEncoding(a: Attrs): string | null {
  const v = a.get('working-tree-encoding');
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

export function binaryByAttr(a: Attrs): boolean {
  return a.get('diff') === false;
}
