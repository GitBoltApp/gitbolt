import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../forge/poll', () => ({ refreshMr: vi.fn(async () => {}) }));
const { resolveImage } = await import('./images');
const { resolveRepoPath } = await import('./fileContext');
const { patchForge, useForge } = await import('../forge/mrStore');
const { projectOf } = await import('../forge/testMrs');

const forge = { kind: 'forge', tabId: 't' } as const;
const file = { kind: 'file', tabId: 't', commit: 'c0ffee1', path: 'docs/README.md' } as const;

beforeEach(() => { useForge.setState({ byTab: {} }); });

describe('the image host policy (spec #5 §4.2)', () => {
  it('GitLab: the account host and project uploads load; other hosts wait for a click', () => {
    patchForge('t', { kind: 'gitlab', project: projectOf() });
    expect(resolveImage(forge, '/uploads/0123abcd0123abcd/shot.png')).toEqual({ kind: 'forge', url: 'https://gitlab.example.com/-/project/42/uploads/0123abcd0123abcd/shot.png' });
    expect(resolveImage(forge, 'https://gitlab.example.com/group/project/-/raw/main/a.png')).toEqual({ kind: 'forge', url: 'https://gitlab.example.com/group/project/-/raw/main/a.png' });
    expect(resolveImage(forge, 'https://example.org/a.png')).toEqual({ kind: 'remote', url: 'https://example.org/a.png', host: 'example.org' });
  });

  it('protocol-relative and backslash srcs are never repo paths and never load (T4 review)', () => {
    patchForge('t', { kind: 'gitlab', project: projectOf() });
    for (const s of ['//cdn.example.org/a.png', '\\\\cdn.example.org/a.png', '/\t/cdn.example.org/a.png', '\\/gitlab.example.com/a.png', '//gitlab.example.com/group/project/a.png']) {
      expect(resolveImage(forge, s)).toEqual({ kind: 'none' });
      expect(resolveImage(file, s)).toEqual({ kind: 'none' });
    }
  });

  it('GitHub: github.com and GitHub’s image hosts load', () => {
    patchForge('t', { kind: 'github', project: projectOf('octo-org/widget', 'github') });
    for (const u of ['https://github.com/user-attachments/assets/1b2c3d4e-0000-4000-8000-00000000abcd', 'https://private-user-images.githubusercontent.com/1/2-x.png?jwt=a', 'https://raw.githubusercontent.com/o/r/main/a.png', 'https://user-images.githubusercontent.com/1/a.png', 'https://avatars.githubusercontent.com/u/1']) {
      expect(resolveImage(forge, u)).toEqual({ kind: 'forge', url: u });
    }
  });

  it('never plain http, userinfo, or a script or SVG data URL; raster data URLs as they are', () => {
    patchForge('t', { kind: 'gitlab', project: projectOf() });
    for (const s of ['http://example.org/a.png', 'https://user:pw@example.org/a.png', 'javascript:alert(1)', 'java\tscript:alert(1)', 'data:image/svg+xml;base64,PHN2Zz4=', '', 'docs/a.png']) expect(resolveImage(forge, s)).toEqual({ kind: 'none' });
    expect(resolveImage(file, 'java\tscript:alert(1)')).toEqual({ kind: 'none' });
    expect(resolveImage(forge, 'data:image/png;base64,iVBORw0KGgo=')).toEqual({ kind: 'data', url: 'data:image/png;base64,iVBORw0KGgo=' });
  });

  it('a relative image in File View is the repo’s, repo-root-relative, at the document’s commit', () => {
    expect(resolveImage(file, '../img/a.png?raw=1')).toEqual({ kind: 'repo', path: 'img/a.png', commit: 'c0ffee1' });
    expect(resolveImage(file, 'shots/a.png#frag')).toEqual({ kind: 'repo', path: 'docs/shots/a.png', commit: 'c0ffee1' });
    expect(resolveImage(file, '../../outside.png')).toEqual({ kind: 'none' });
  });

  it('hands the src to resolveRepoPath exactly as written (it decodes percent-escapes itself)', () => {
    // `docs/shots/a b.png` once resolveRepoPath decodes (the T4 fix lane); never decoded around it.
    expect(resolveImage(file, 'shots/a%20b.png')).toEqual({ kind: 'repo', path: resolveRepoPath('docs/README.md', 'shots/a%20b.png'), commit: 'c0ffee1' });
  });

  it('plain http only on the forge’s own web origin (the harness)', () => {
    patchForge('t', { kind: 'gitlab', project: { ...projectOf(), webUrl: 'http://127.0.0.1:9/gitlab/group/project' } });
    expect(resolveImage(forge, '/uploads/0123abcd0123abcd/a.png')).toEqual({ kind: 'forge', url: 'http://127.0.0.1:9/gitlab/-/project/42/uploads/0123abcd0123abcd/a.png' });
  });
});
