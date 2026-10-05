import { beforeAll, describe, expect, it } from 'vitest';
import { toString } from './testText';
import { loadEmoji } from '../../forge/emoji';
import { clearParseCache, parseMarkdown } from '../parse';

beforeAll(async () => { await loadEmoji(); clearParseCache(); });

describe('the emoji plugin (spec #5 §3.1)', () => {
  it('turns :shortcode: into the emoji outside code, and leaves unknown ones', () => {
    const tree = parseMarkdown('Ship it :+1: :rocket: :nope:\n\n`:+1:`\n\n```\n:rocket:\n```', 'github');
    expect(toString(tree)).toBe('Ship it 👍 🚀 :nope:\n:+1:\n:rocket:');
  });
});
