import { describe, expect, it } from 'vitest';
import type { ForgeUser } from '../api/gen/ForgeUser';
import { insertToken } from './emojiComplete';
import { findMention, mergePeople, participantsOf, rankPeople } from './mentions';

const u = (id: number, username: string, name = username): ForgeUser => ({ id, username, name, avatarUrl: null, webUrl: '', email: null });
const ada = u(1, 'ada', 'Ada Lovelace'), bob = u(2, 'bob', 'Robert B'), abe = u(3, 'abe', 'Abe');
const f = (s: string) => findMention(s, s.length);

describe('findMention', () => {
  it('fires for a bare @, at the start, after space or a bracket', () => {
    expect(f('@')).toEqual({ start: 0, query: '' });
    expect(f('cc @ad')).toEqual({ start: 3, query: 'ad' });
    expect(f('(@Bo')).toEqual({ start: 1, query: 'bo' });
  });
  it('not in emails, words or code', () => {
    expect(f('mail me@host')).toBeNull();
    expect(f('a@b')).toBeNull();
    expect(f('`x @ad')).toBeNull();
    expect(f('```\n@ad')).toBeNull();
  });
});

describe('people', () => {
  it('ranks prefix before substring, by username or name, keeping the given order', () => {
    expect(rankPeople([bob, ada, abe], 'a').map((x) => x.username)).toEqual(['ada', 'abe']);
    expect(rankPeople([bob, ada, abe], 'love').map((x) => x.username)).toEqual(['ada']);
    expect(rankPeople([bob, ada], '').map((x) => x.username)).toEqual(['bob', 'ada']);
  });
  it('lists the MR people once each, then search results', () => {
    expect(participantsOf([ada, null, bob, ada]).map((x) => x.id)).toEqual([1, 2]);
    expect(mergePeople([ada], [ada, bob, abe], 2).map((x) => x.id)).toEqual([1, 2]);
  });
  it('inserts @username and a space', () => {
    expect(insertToken('cc @a x', 5, { start: 3, query: 'a' }, '@ada ')).toEqual({ text: 'cc @ada  x', caret: 8 });
  });
});
