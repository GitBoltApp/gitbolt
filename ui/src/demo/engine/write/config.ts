// The repository's own config file, edited line by line as `git config` and `git branch` edit it,
// for the keys GitVolt writes: `branch.<name>.<var>` (write/config.rs) and, from plan 4 on,
// `remote.<name>.<var>` and `remote.pushdefault` (write/remotes.rs). A section header is
// `[section "<subsection>"]` (or `[section]`); a key line `\t<var> = <value>`. A full key is
// `section.subsection.var` as `git config --list` gives it: the section and the variable
// lower-cased, the subsection as written.
import type { DemoRepo } from '../repo';

export interface ConfigChange {
  key: string;
  old: string[];
  new: string[];
}

/** Full key (`branch.feature/x.remote`, the variable lower-cased) → its values in file order. */
export type BranchConfig = Map<string, string[]>;

interface Line {
  text: string;
  /** The section the line is in (its header included), lower-cased; null before any. */
  section: string | null;
  /** Its subsection as written; null for a plain `[section]`. */
  sub: string | null;
  header: boolean;
  /** A key line's variable (lower-cased) and value. */
  key: string | null;
  value: string | null;
}

const file = (demo: DemoRepo) => `${demo.gitdir}/config`;

/** A value as git reads it: quotes group, `\"` `\\` `\n` `\t` escape, an unquoted `#`/`;` starts a comment. */
function unquote(raw: string): string {
  let out = '';
  let quoted = false;
  let keep = 0;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '\\' && i + 1 < raw.length) {
      const n = raw[++i];
      out += n === 'n' ? '\n' : n === 't' ? '\t' : n;
      keep = out.length;
    } else if (c === '"') {
      quoted = !quoted;
      keep = out.length;
    } else if (!quoted && (c === '#' || c === ';')) break;
    else {
      out += c;
      if (quoted || !/\s/.test(c)) keep = out.length;
    }
  }
  return out.slice(0, keep);
}

/** A value as git writes it: quoted when it has to be. */
function quote(value: string): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t');
  return /^\s|\s$|[#;]/.test(value) ? `"${escaped}"` : escaped;
}

function parse(text: string): Line[] {
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  let section: string | null = null;
  let sub: string | null = null;
  return lines.map((t) => {
    const h = /^\s*\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]/.exec(t);
    if (h) {
      const name = h[1].toLowerCase();
      // The old `[section.subsection]` form: its subsection is lower-cased, as git reads it.
      const dot = name.indexOf('.');
      [section, sub] = h[2] !== undefined ? [name, h[2].replace(/\\(.)/g, '$1')] : dot < 0 ? [name, null] : [name.slice(0, dot), name.slice(dot + 1)];
      return { text: t, section, sub, header: true, key: null, value: null };
    }
    const kv = /^\s*([A-Za-z][A-Za-z0-9-]*)\s*(?:=\s*(.*))?$/.exec(t);
    return { text: t, section, sub, header: false, key: kv ? kv[1].toLowerCase() : null, value: kv ? (kv[2] === undefined ? 'true' : unquote(kv[2])) : null };
  });
}

function readLines(demo: DemoRepo): Line[] {
  try {
    return parse(demo.fs.readFileSync(file(demo), 'utf8') as string);
  } catch {
    return [];
  }
}

function writeLines(demo: DemoRepo, lines: Line[]): void {
  demo.fs.writeFileSync(file(demo), lines.length === 0 ? '' : `${lines.map((l) => l.text).join('\n')}\n`);
}

type Where = { section: string; sub: string | null };

/** `section.subsection.var` → its parts: the section is up to the first dot, the variable after the
 *  last, so a dotted branch name keeps its dots (`branch.v1.2.remote` belongs to `v1.2`). */
function split(key: string): Where & { v: string; written: string } {
  const first = key.indexOf('.');
  const last = key.lastIndexOf('.');
  if (first <= 0 || last === key.length - 1) throw new Error(`not a config key: ${key}`);
  return { section: key.slice(0, first).toLowerCase(), sub: first === last ? null : key.slice(first + 1, last), v: key.slice(last + 1).toLowerCase(), written: key.slice(last + 1) };
}

const inSection = (l: Line, w: Where) => l.section === w.section && l.sub === w.sub;
const fullKey = (l: Line) => `${l.section}${l.sub === null ? '' : `.${l.sub}`}.${l.key}`;
const headerText = (w: Where) => (w.sub === null ? `[${w.section}]` : `[${w.section} "${w.sub.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`);

/** `section` (`remote.origin`, `core`) → where its lines are. */
function whereOf(section: string): Where {
  const dot = section.indexOf('.');
  return dot < 0 ? { section: section.toLowerCase(), sub: null } : { section: section.slice(0, dot).toLowerCase(), sub: section.slice(dot + 1) };
}

export function branchConfig(demo: DemoRepo, name: string): BranchConfig {
  const out: BranchConfig = new Map();
  for (const l of readLines(demo)) {
    if (!inSection(l, { section: 'branch', sub: name }) || l.key === null) continue;
    const k = `branch.${name}.${l.key}`;
    out.set(k, [...(out.get(k) ?? []), l.value ?? 'true']);
  }
  return out;
}

/** The core's `local_config` (write/remotes.rs): `git config --local --null --list`, key and value in
 *  file order. A key with no `=` reads as "true", as the core parses it, and that's what a replay
 *  writes back. */
export function readLocalConfig(demo: DemoRepo): [string, string][] {
  return readLines(demo).flatMap((l): [string, string][] => (l.section !== null && l.key !== null ? [[fullKey(l), l.value ?? 'true']] : []));
}

/** Every value of `key` replaced by `values` in order (`--unset-all`, then `--add` each), in the
 *  key's last section, made at the end of the file when there's none; the variable written as given. */
export function setConfigValues(demo: DemoRepo, key: string, values: string[]): void {
  const w = split(key);
  const lines = readLines(demo).filter((l) => !(inSection(l, w) && l.key === w.v));
  if (values.length > 0) {
    let at = -1;
    lines.forEach((l, i) => {
      if (inSection(l, w)) at = i;
    });
    if (at < 0) {
      lines.push({ text: headerText(w), section: w.section, sub: w.sub, header: true, key: null, value: null });
      at = lines.length - 1;
    }
    lines.splice(at + 1, 0, ...values.map((value) => ({ text: `\t${w.written} = ${quote(value)}`, section: w.section, sub: w.sub, header: false, key: w.v, value })));
  }
  // Git drops a section when its last key goes.
  if (!lines.some((l) => inSection(l, w) && l.key !== null)) {
    writeLines(demo, lines.filter((l) => !inSection(l, w)));
    return;
  }
  writeLines(demo, lines);
}

/** `git config --remove-section <section>` (every such section; none: nothing changes). */
export function removeConfigSection(demo: DemoRepo, section: string): void {
  const w = whereOf(section);
  writeLines(demo, readLines(demo).filter((l) => !inSection(l, w)));
}

/** `git config --remove-section branch.<name>`. */
export function removeBranchSection(demo: DemoRepo, name: string): void {
  removeConfigSection(demo, `branch.${name}`);
}

/** `git branch -m`'s config move: each `[branch "<from>"]` header renamed. */
export function renameBranchSection(demo: DemoRepo, from: string, to: string): void {
  const [was, now] = [{ section: 'branch', sub: from }, { section: 'branch', sub: to }];
  writeLines(demo, readLines(demo).map((l) => (l.header && inSection(l, was) ? { ...l, text: headerText(now), sub: to } : l)));
}

const rank = (key: string) => (key.endsWith('.remote') ? 0 : key.endsWith('.merge') ? 1 : 2);

/** Every key whose values differ, in git's write order: `remote`, `merge`, then the rest by key. */
export function configChanges(before: BranchConfig, after: BranchConfig): ConfigChange[] {
  const keys = [...new Set([...before.keys(), ...after.keys()])].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
  const out: ConfigChange[] = [];
  for (const key of keys) {
    const old = before.get(key) ?? [];
    const next = after.get(key) ?? [];
    if (old.length !== next.length || old.some((x, i) => x !== next[i])) out.push({ key, old, new: next });
  }
  return out;
}

/** Each change's key set to its `old` values (`toOld`: undo) or its `new` ones (redo); a section left
 *  empty goes (`setConfigValues`). */
export function applyConfigChanges(demo: DemoRepo, changes: ConfigChange[], toOld: boolean): void {
  for (const c of changes) setConfigValues(demo, c.key, toOld ? c.old : c.new);
}
