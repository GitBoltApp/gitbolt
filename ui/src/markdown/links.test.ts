import { describe, expect, it, vi } from 'vitest';
// The real resolver, watched: `targetOfHref` hands it the href undecoded (it decodes itself).
const fc = vi.hoisted(() => ({ resolveRepoPath: null as unknown as import('vitest').Mock }));
vi.mock('./fileContext', async (orig) => {
  const m = await orig<typeof import('./fileContext')>();
  fc.resolveRepoPath = vi.fn(m.resolveRepoPath);
  return { resolveRepoPath: (...a: Parameters<typeof m.resolveRepoPath>) => fc.resolveRepoPath(...a) };
});
import { targetOfHref, targetOfReference, type LinkEnv } from './links';
import type { MarkdownContext, MdReferenceNode } from './types';

const SHA = 'abc1234def5678abc1234def5678abc1234def56';
const gl: LinkEnv = { kind: 'gitlab', project: { path: 'group/project', webUrl: 'https://gitlab.example.com/group/project', defaultBranch: 'main' }, fullSha: (p) => (SHA.startsWith(p) ? SHA : null) };
const gh: LinkEnv = { kind: 'github', project: { path: 'octo-org/widget', webUrl: 'https://github.com/octo-org/widget', defaultBranch: 'main' }, fullSha: () => null };
const none: LinkEnv = { kind: null, project: null, fullSha: () => null };
const forge: MarkdownContext = { kind: 'forge', tabId: 't' };
const file: MarkdownContext = { kind: 'file', tabId: 't', commit: 'c0ffee1', path: 'docs/README.md' };
const ref = (refKind: MdReferenceNode['refKind'], value: string, over: Partial<MdReferenceNode> = {}): MdReferenceNode => ({ type: 'reference', refKind, project: null, number: null, sha: null, user: null, value, ...over });

describe('where a reference goes (spec #5 §4.1)', () => {
  it('GitLab: !n in this project opens in-app; another project’s and #n issues open in the browser', () => {
    expect(targetOfReference(gl, ref('mr', '!12', { number: 12 }))).toEqual({ kind: 'mr', number: 12, webUrl: 'https://gitlab.example.com/group/project/-/merge_requests/12' });
    expect(targetOfReference(gl, ref('mr', 'Group/Project!12', { project: 'Group/Project', number: 12 }))).toMatchObject({ kind: 'mr', number: 12 });
    expect(targetOfReference(gl, ref('mr', 'other/proj!3', { project: 'other/proj', number: 3 }))).toEqual({ kind: 'external', url: 'https://gitlab.example.com/other/proj/-/merge_requests/3' });
    expect(targetOfReference(gl, ref('issue', '#7', { number: 7 }))).toEqual({ kind: 'external', url: 'https://gitlab.example.com/group/project/-/issues/7' });
  });

  it('GitHub: #n in this repository tries the PR view; another repository’s opens in the browser', () => {
    expect(targetOfReference(gh, ref('issue', '#4', { number: 4 }))).toEqual({ kind: 'mr', number: 4, webUrl: 'https://github.com/octo-org/widget/issues/4' });
    expect(targetOfReference(gh, ref('issue', 'someone/else#9', { project: 'someone/else', number: 9 }))).toEqual({ kind: 'external', url: 'https://github.com/someone/else/issues/9' });
  });

  it('a SHA in the graph selects it; one that isn’t opens the forge; with no forge, nothing', () => {
    expect(targetOfReference(gl, ref('commit', 'abc1234', { sha: 'abc1234' }))).toEqual({ kind: 'commit', sha: SHA, webUrl: null });
    expect(targetOfReference(gl, ref('commit', 'fed9876', { sha: 'fed9876' }))).toEqual({ kind: 'commit', sha: 'fed9876', webUrl: 'https://gitlab.example.com/group/project/-/commit/fed9876' });
    expect(targetOfReference(none, ref('commit', 'fed9876', { sha: 'fed9876' }))).toEqual({ kind: 'inert' });
  });

  it('@user opens the profile on the forge', () => {
    expect(targetOfReference(gh, ref('mention', '@octocat', { user: 'octocat' }))).toEqual({ kind: 'external', url: 'https://github.com/octocat' });
    expect(targetOfReference(none, ref('mention', '@octocat', { user: 'octocat' }))).toEqual({ kind: 'inert' });
  });
});

describe('where a link goes (spec #5 §4.1)', () => {
  it('#heading scrolls to its user-content id', () => {
    expect(targetOfHref(gl, forge, '#install-it')).toEqual({ kind: 'anchor', id: 'user-content-install-it' });
    expect(targetOfHref(gl, forge, '#user-content-fn-1')).toEqual({ kind: 'anchor', id: 'user-content-fn-1' });
  });

  it('http(s) and mailto open the browser, except this project’s MR/PR and commit pages', () => {
    expect(targetOfHref(gl, forge, 'https://example.org/x')).toEqual({ kind: 'external', url: 'https://example.org/x' });
    expect(targetOfHref(gl, forge, 'mailto:ada@example.com')).toEqual({ kind: 'external', url: 'mailto:ada@example.com' });
    expect(targetOfHref(gl, forge, 'https://gitlab.example.com/group/project/-/merge_requests/5#note_1')).toEqual({ kind: 'mr', number: 5, webUrl: 'https://gitlab.example.com/group/project/-/merge_requests/5#note_1' });
    expect(targetOfHref(gh, forge, 'https://github.com/octo-org/widget/pull/6/files')).toMatchObject({ kind: 'mr', number: 6 });
    expect(targetOfHref(gl, forge, `https://gitlab.example.com/group/project/-/commit/${SHA}`)).toEqual({ kind: 'commit', sha: SHA, webUrl: null });
    expect(targetOfHref(gh, forge, 'https://github.com/someone/else/pull/6')).toEqual({ kind: 'external', url: 'https://github.com/someone/else/pull/6' });
  });

  it('anything else is inert: script schemes, even hidden by whitespace or case', () => {
    for (const h of ['javascript:alert(1)', ' JaVa\tScRiPt:alert(1)', 'vbscript:x', 'data:text/html,x', 'file:///etc/passwd', '']) expect(targetOfHref(gl, forge, h)).toEqual({ kind: 'inert' });
  });

  it('a relative path is a repo-root-relative file at the document’s commit, or from the root in a forge context', () => {
    expect(targetOfHref(gl, file, '../CHANGES.md#v2')).toEqual({ kind: 'file', path: 'CHANGES.md', commit: 'c0ffee1', anchor: 'v2' });
    expect(targetOfHref(gl, file, 'guide/setup.md')).toEqual({ kind: 'file', path: 'docs/guide/setup.md', commit: 'c0ffee1', anchor: null });
    expect(targetOfHref(gl, forge, 'docs/a.md')).toEqual({ kind: 'file', path: 'docs/a.md', commit: 'worktree', anchor: null });
  });

  it('hands resolveRepoPath the href as written, less its anchor: never decoded (it decodes itself)', () => {
    fc.resolveRepoPath.mockClear();
    targetOfHref(gl, file, 'guide/a%20b.md#x%20y');
    expect(fc.resolveRepoPath).toHaveBeenCalledWith('docs/README.md', 'guide/a%20b.md');
  });

  it('protocol-relative and backslash hrefs are inert, never a repo path', () => {
    for (const h of ['//evil.example/x', '\\\\evil.example\\x', '/\\evil.example', '/\t/evil.example', '\\/evil.example']) expect(targetOfHref(gl, file, h)).toEqual({ kind: 'inert' });
  });

  it('a relative path above the repository root is inert', () => {
    expect(targetOfHref(gl, file, '../../outside.md')).toEqual({ kind: 'inert' });
  });
});
