import { describe, expect, it } from 'vitest';
import { plainExcerpt } from './excerpt';

describe('a comment’s plain-text excerpt', () => {
  it('reads a suggestion as "Suggested change", then the text after it', () => {
    expect(plainExcerpt('```suggestion:-5+0\nfunction handle(\n  $request,\n```\n\nThis drops the unused argument.')).toBe('Suggested change · This drops the unused argument.');
    expect(plainExcerpt('Maybe:\n\n````suggestion\nconst a = "```";\n````')).toBe('Maybe: · Suggested change');
  });

  it('flattens other Markdown to its text: no fences, no markup', () => {
    expect(plainExcerpt('## Why **this** _line_?\n\nSee [the docs](https://docs.example.test) and `config.yml`.')).toBe('Why this line? · See the docs and config.yml.');
    expect(plainExcerpt('> quoted\n> more\n\n- [x] done\n1. first\n\n---\n\n<b>bold</b> ~~old~~ snake_case_name \\*star')).toBe('quoted more · done first · bold old snake_case_name *star');
    expect(plainExcerpt('```ts\nconst a = 1;\n```')).toBe('const a = 1;');
    expect(plainExcerpt('![diagram](a.png)\n| a | b |\n|---|---|\n| 1 | 2 |')).toBe('diagram a b 1 2');
  });

  it('is empty for a blank body', () => {
    expect(plainExcerpt('\n  \n')).toBe('');
  });
});
