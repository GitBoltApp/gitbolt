/** Emoji autocomplete for the Markdown field: typing `:sm` offers `:smile:` and friends. */

export interface EmojiEntry { emoji: string; names: string[] }
export interface EmojiHit { emoji: string; name: string }
export interface Trigger { /** Index of the `:`. */ start: number; query: string }

export const MAX_HITS = 8;

/** gemoji has no popularity order, so the everyday ones are named here and sort first. */
const COMMON = ['+1', 'thumbsup', '-1', 'thumbsdown', 'smile', 'tada', 'heart', 'eyes', 'rocket', 'white_check_mark', 'warning', 'bug', 'fire', 'pray', 'joy', 'thinking', 'clap', 'sparkles', 'x', 'memo'];
const COMMON_RANK = new Map(COMMON.map((n, i) => [n, i]));

const inFence = (before: string): boolean => {
  let open = false;
  for (const line of before.split('\n').slice(0, -1)) if (/^\s{0,3}(```|~~~)/.test(line)) open = !open;
  return open;
};

/** Whether the character at `start` is inside fenced code or an inline code span. */
export function inCode(before: string, start: number): boolean {
  if (inFence(before)) return true;
  const lineStart = before.lastIndexOf('\n') + 1;
  return (before.slice(lineStart, start).match(/`/g)?.length ?? 0) % 2 === 1;
}

/** The shortcode being typed just before `caret`, or null (no popup): the colon starts the text
 * or follows whitespace or an opening bracket (so not `http://`, `12:30` or `a:b`), at least two
 * word characters follow it, and the caret is not in fenced or inline code. */
export function findTrigger(text: string, caret: number): Trigger | null {
  const before = text.slice(0, caret);
  const m = /(^|[\s([{]):([a-z0-9_+-]{2,})$/i.exec(before);
  if (!m) return null;
  const start = m.index + m[1].length;
  if (inCode(before, start)) return null;
  return { start, query: m[2].toLowerCase() };
}

/** Up to `limit` matches: names (and aliases) starting with the query, then those containing
 * it, each group with the common ones first and otherwise in gemoji's order. */
export function rankEmoji(list: readonly EmojiEntry[], query: string, limit = MAX_HITS): EmojiHit[] {
  const q = query.toLowerCase();
  type Row = EmojiHit & { c: number; i: number };
  const prefix: Row[] = [];
  const inner: Row[] = [];
  list.forEach((e, i) => {
    let best: { name: string; pre: boolean } | null = null;
    for (const name of e.names) {
      const at = name.indexOf(q);
      if (at < 0) continue;
      if (at === 0) { best = { name, pre: true }; break; }
      best ??= { name, pre: false };
    }
    if (!best) return;
    const c = Math.min(...e.names.map((n) => COMMON_RANK.get(n) ?? 99));
    (best.pre ? prefix : inner).push({ emoji: e.emoji, name: best.name, c, i });
  });
  const by = (a: Row, b: Row) => a.c - b.c || a.i - b.i;
  return [...prefix.sort(by), ...inner.sort(by)].slice(0, limit).map(({ emoji, name }) => ({ emoji, name }));
}

/** `text` with the typed trigger and query replaced by `token`, and the caret after it. */
export function insertToken(text: string, caret: number, trigger: Trigger, token: string): { text: string; caret: number } {
  return { text: text.slice(0, trigger.start) + token + text.slice(caret), caret: trigger.start + token.length };
}

/** `insertToken` for `:name: `. */
export const insertShortcode = (text: string, caret: number, trigger: Trigger, name: string) => insertToken(text, caret, trigger, `:${name}: `);

/** The list, loaded once on first need as gemoji's own chunk. */
let listing: Promise<readonly EmojiEntry[]> | null = null;
export function loadEmojiList(): Promise<readonly EmojiEntry[]> {
  listing ??= import('gemoji').then((m) => m.gemoji, (e: unknown) => { listing = null; throw e; });
  return listing;
}
