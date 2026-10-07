import { describe, expect, it } from 'vitest';
import { findTrigger, insertShortcode, rankEmoji, type EmojiEntry } from './emojiComplete';

const t = (s: string) => findTrigger(s, s.length);
const L: EmojiEntry[] = [
  { emoji: 'A', names: ['smiley'] },
  { emoji: 'B', names: ['grin_smile'] },
  { emoji: 'C', names: ['smile'] },
  { emoji: 'D', names: ['+1', 'thumbsup'] },
  { emoji: 'E', names: ['thumbsdown', '-1'] },
];

describe('findTrigger', () => {
  it('fires at the start, after a space or newline, and after an opening bracket', () => {
    expect(t(':sm')).toEqual({ start: 0, query: 'sm' });
    expect(t('hi :+1')).toEqual({ start: 3, query: '+1' });
    expect(t('a\n:thu')).toEqual({ start: 2, query: 'thu' });
    expect(t('(:sm')).toEqual({ start: 1, query: 'sm' });
  });
  it('needs two characters', () => { expect(t(':s')).toBeNull(); expect(t(':')).toBeNull(); });
  it('stays quiet in URLs, times and words', () => {
    expect(t('see http://example')).toBeNull();
    expect(t('at 12:30')).toBeNull();
    expect(t('a:bc')).toBeNull();
  });
  it('stays quiet after a finished shortcode', () => { expect(t(':smile:')).toBeNull(); });
  it('stays quiet in inline and fenced code', () => {
    expect(t('run `x :sm')).toBeNull();
    expect(t('```\n:sm')).toBeNull();
    expect(t('```\ncode\n```\n:sm')).not.toBeNull();
    expect(t('`a` :sm')).not.toBeNull();
  });
  it('uses the caret, not the end', () => { expect(findTrigger(':sm tail', 3)).toEqual({ start: 0, query: 'sm' }); });
});

describe('rankEmoji', () => {
  it('puts prefix matches before substring matches, common names first', () => {
    expect(rankEmoji(L, 'smi').map((h) => h.name)).toEqual(['smile', 'smiley', 'grin_smile']);
  });
  it('matches aliases and reports the matching name', () => {
    expect(rankEmoji(L, 'thu').map((h) => h.name)).toEqual(['thumbsup', 'thumbsdown']);
    expect(rankEmoji(L, '+1')[0]).toEqual({ emoji: 'D', name: '+1' });
  });
  it('caps the list', () => { expect(rankEmoji(L, 'sm', 2)).toHaveLength(2); });
  it('finds nothing for nonsense', () => { expect(rankEmoji(L, 'zzz')).toEqual([]); });
});

describe('insertShortcode', () => {
  it('replaces the typed query with :name: and a space', () => {
    expect(insertShortcode('hi :thu there', 7, { start: 3, query: 'thu' }, 'thumbsup')).toEqual({ text: 'hi :thumbsup:  there', caret: 14 });
  });
});
