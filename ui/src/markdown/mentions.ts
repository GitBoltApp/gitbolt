import type { ForgeUser } from '../api/gen/ForgeUser';
import { inCode, MAX_HITS, type Trigger } from './emojiComplete';

/** The `@handle` being typed just before `caret`, or null: the @ starts the text or follows
 * whitespace or an opening bracket (so not an email's `a@b`), and is not in code. The query may
 * be empty (a bare @ lists the MR's people). */
export function findMention(text: string, caret: number): Trigger | null {
  const before = text.slice(0, caret);
  const m = /(^|[\s([{])@([\w.-]*)$/.exec(before);
  if (!m) return null;
  const start = m.index + m[1].length;
  if (inCode(before, start)) return null;
  return { start, query: m[2].toLowerCase() };
}

/** The `users` that match `query` (username or display name): prefix matches, then substring
 * ones, each group in the given order (the MR's people come in as given: author, reviewers,
 * assignees, commenters). Everyone for an empty query. */
export function rankPeople(users: readonly ForgeUser[], query: string): ForgeUser[] {
  const q = query.toLowerCase();
  if (!q) return [...users];
  const rank = (u: ForgeUser): number => {
    const names = [u.username.toLowerCase(), u.name.toLowerCase()];
    if (names.some((x) => x.startsWith(q)) || names[1].split(/\s+/).some((w) => w.startsWith(q))) return 0;
    return names.some((x) => x.includes(q)) ? 1 : 2;
  };
  return users.map((u, i) => ({ u, r: rank(u), i })).filter((x) => x.r < 2).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.u);
}

/** `first` (the MR's people) then `more` (search results) without repeats, up to `limit`. */
export function mergePeople(first: readonly ForgeUser[], more: readonly ForgeUser[], limit = MAX_HITS): ForgeUser[] {
  const seen = new Set<number>();
  const out: ForgeUser[] = [];
  for (const u of [...first, ...more]) {
    if (seen.has(u.id)) continue;
    seen.add(u.id);
    out.push(u);
  }
  return out.slice(0, limit);
}

/** Everyone the MR/PR involves, once each, in order: author, reviewers, assignees, commenters. */
export const participantsOf = (people: ReadonlyArray<ForgeUser | null | undefined>): ForgeUser[] =>
  mergePeople(people.filter((u): u is ForgeUser => !!u), [], Infinity);
