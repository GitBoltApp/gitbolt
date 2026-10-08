import type { Code, PhrasingContent, Root, RootContent, Table, TableRow } from 'mdast';
import type { Literal } from 'mdast';
import { parse as parseToml, TomlDate } from 'smol-toml';
import { parseDocument, stringify, type ToJSOptions } from 'yaml';

/** What `remark-frontmatter` leaves at the start of the tree (mdast-util-frontmatter's nodes). */
interface Matter extends Literal { type: 'yaml' | 'toml' }

declare module 'mdast' {
  /** `gbFrontmatter`: the table is a file's front matter (keys on the left, values on the right). */
  interface TableData { gbFrontmatter?: 'yaml' | 'toml' }
}

const text = (value: string): PhrasingContent[] => (value === '' ? [] : [{ type: 'text', value }]);
/** A value as a cell's content: text, never Markdown; a list or a map as its YAML, flow style. */
function cellOf(v: unknown): PhrasingContent[] {
  if (v === null || v === undefined) return [];
  if (v instanceof TomlDate) return text(v.toISOString());
  if (v instanceof Date) return text(v.toISOString());
  if (typeof v === 'object') return [{ type: 'inlineCode', value: stringify(v, { collectionStyle: 'flow', lineWidth: 0 }).trim() }];
  return text(String(v).replace(/\n+$/, ''));
}

// Plain data only: the core schema (no timestamps or custom tags; an unknown tag stays a string),
// unique keys, and yaml's default cap on alias expansion.
const TO_JS: ToJSOptions = { mapAsMap: true, maxAliasCount: 100 };

/** The block's keys and values, in order; `null`: it doesn't parse, or isn't a map. */
function entriesOf(m: Matter): Array<[string, unknown]> | null {
  try {
    if (m.type === 'toml') return Object.entries(parseToml(m.value));
    const doc = parseDocument(m.value, { schema: 'core', merge: false, uniqueKeys: true, prettyErrors: false });
    if (doc.errors.length > 0) return null;
    const js: unknown = doc.toJS(TO_JS);
    if (js === null || js === undefined) return [];
    if (!(js instanceof Map)) return null;
    return [...js].map(([k, v]) => [typeof k === 'string' ? k : stringify(k, { collectionStyle: 'flow', lineWidth: 0 }).trim(), v]);
  } catch {
    return null;
  }
}

/** Maps nested in a value as plain objects, for `stringify` (`mapAsMap` keeps the top level's order). */
const plain = (v: unknown): unknown =>
  v instanceof Map ? Object.fromEntries([...v].map(([k, x]) => [String(k), plain(x)])) : Array.isArray(v) ? v.map(plain) : v;

/** A file's front matter (`---` YAML or `+++` TOML, only at its very start: `remark-frontmatter`)
 * as GitHub shows it, a table: a row per key, its value on the right, as text. Malformed, or not
 * a map: a code block of its source. Empty: nothing. */
export function remarkFrontmatterTable() {
  return (tree: Root) => {
    const first = tree.children[0] as RootContent | Matter | undefined;
    if (!first || (first.type !== 'yaml' && first.type !== 'toml')) return;
    const m = first as Matter;
    const entries = entriesOf(m);
    let out: RootContent[];
    if (entries === null) {
      out = [{ type: 'code', lang: m.type, meta: null, value: m.value, position: m.position } satisfies Code];
    } else if (entries.length === 0) {
      out = [];
    } else {
      const rows: TableRow[] = entries.map(([k, v]) => ({ type: 'tableRow', children: [{ type: 'tableCell', children: text(k) }, { type: 'tableCell', children: cellOf(plain(v)) }] }));
      out = [{ type: 'table', align: [null, null], children: rows, data: { gbFrontmatter: m.type }, position: m.position } satisfies Table];
    }
    tree.children.splice(0, 1, ...out);
  };
}
