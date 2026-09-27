import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mergeRequestButtons, projectRemote, referenceLabels, tokenizeMessage, type ProjectRemote } from './messageLinks';

const gitlab: ProjectRemote = { host: 'gitlab.example.com', path: 'group/project', hostKind: 'gitlab' };
const github: ProjectRemote = { host: 'github.com', path: 'owner/repo', hostKind: 'github' };
const links = (text: string, r: ProjectRemote | null) =>
  tokenizeMessage(text, r)
    .filter((t) => t.kind === 'link')
    .map((t) => (t.kind === 'link' ? [t.text, t.url] : []));

describe('message links', () => {
  it('links GitLab MRs, issues and URLs, and makes buttons for MRs only', () => {
    const text = 'Refs !42 and group/sub/project!7, fixes #12.\nSee https://example.com/docs for details.';
    expect(links(text, gitlab)).toEqual([
      ['!42', 'https://gitlab.example.com/group/project/-/merge_requests/42'],
      ['group/sub/project!7', 'https://gitlab.example.com/group/sub/project/-/merge_requests/7'],
      ['#12', 'https://gitlab.example.com/group/project/-/issues/12'],
      ['https://example.com/docs', 'https://example.com/docs'],
    ]);
    expect(mergeRequestButtons(tokenizeMessage(text + ' Again !42.', gitlab))).toEqual([
      { label: 'Open !42', url: 'https://gitlab.example.com/group/project/-/merge_requests/42' },
      { label: 'Open group/sub/project!7', url: 'https://gitlab.example.com/group/sub/project/-/merge_requests/7' },
    ]);
    expect(
      tokenizeMessage(text, gitlab)
        .map((t) => t.text)
        .join(''),
    ).toBe(text);
  });

  it('links GitHub PR references; generic hosts link URLs only', () => {
    expect(links('Closes #5 and other/repo#6, not !3', github)).toEqual([
      ['#5', 'https://github.com/owner/repo/pull/5'],
      ['other/repo#6', 'https://github.com/other/repo/pull/6'],
    ]);
    expect(
      links('#5 at https://x.example/a.', { host: 'code.example.com', path: 'a/b', hostKind: 'generic' }),
    ).toEqual([['https://x.example/a', 'https://x.example/a']]);
    expect(links('#5 !6', null)).toEqual([]);
  });

  it('ignores references glued to words', () => {
    expect(links('C#123 abc!4 v1.2#3 x-#9', gitlab)).toEqual([]);
  });

  it('picks the first remote with a host (origin comes first)', () => {
    expect(
      projectRemote([
        { name: 'local', host: null, path: null, hostKind: 'generic' },
        { name: 'up', host: 'github.com', path: 'o/r', hostKind: 'github' },
      ]),
    ).toEqual({ host: 'github.com', path: 'o/r', hostKind: 'github' });
    expect(projectRemote([])).toBeNull();
  });
});

interface Vector {
  message: string;
  refs: string[];
}

// A relative JSON import can be blocked by Vite's fs allow-list under vitest, since the file
// lives outside `ui/`. Read it directly instead (task-12a brief). Vitest's cwd is `ui/`.
const vectorsPath = resolve(process.cwd(), '../testdata/message-refs.json');
const vectors: Vector[] = JSON.parse(readFileSync(vectorsPath, 'utf8'));

describe('referenceLabels (shared vectors with the Rust parser)', () => {
  it('has at least the 8 vectors the Rust test requires', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(8);
  });

  for (const v of vectors) {
    it(`matches parse_message_refs for ${JSON.stringify(v.message)}`, () => {
      expect(referenceLabels(v.message)).toEqual(v.refs);
    });
  }
});
