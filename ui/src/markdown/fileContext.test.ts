import { describe, expect, it } from 'vitest';
import { resolveRepoPath } from './fileContext';

describe('resolveRepoPath (the 5A/5B contract)', () => {
  it('joins the file’s directory and the href, normalized and repo-root-relative', () => {
    expect(resolveRepoPath('docs/guide/README.md', 'setup.md')).toBe('docs/guide/setup.md');
    expect(resolveRepoPath('docs/guide/README.md', './img/../a b.png?raw=1')).toBe('docs/guide/a b.png');
    expect(resolveRepoPath('docs/README.md', '../CHANGES.md')).toBe('CHANGES.md');
    expect(resolveRepoPath('README.md', 'docs//a.md')).toBe('docs/a.md');
  });

  it('is null above the root, or for nothing', () => {
    expect(resolveRepoPath('docs/README.md', '../../x.md')).toBeNull();
    expect(resolveRepoPath('README.md', '?q=1')).toBeNull();
  });

  it('decodes each segment once, before . and .., and never climbs out through an encoding', () => {
    expect(resolveRepoPath('sub/README.md', '%2e%2e/%2e%2e/x')).toBeNull();
    expect(resolveRepoPath('sub/README.md', '..%2f..%2fx')).toBeNull();
    expect(resolveRepoPath('sub/README.md', '..\\..\\x')).toBeNull();
    expect(resolveRepoPath('sub/README.md', 'a%5cb')).toBeNull();
    expect(resolveRepoPath('README.md', 'a%00b')).toBeNull();
    expect(resolveRepoPath('README.md', 'a%zzb')).toBeNull();
    expect(resolveRepoPath('docs/README.md', 'my%20file%C3%A9.md')).toBe('docs/my fileé.md');
    expect(resolveRepoPath('docs/README.md', 'a%3Fb.md?q=%2F')).toBe('docs/a?b.md');
  });

  it('takes a leading / from the repository root', () => {
    expect(resolveRepoPath('sub/dir/README.md', '/docs/x.md')).toBe('docs/x.md');
    expect(resolveRepoPath('sub/README.md', '../x.md')).toBe('x.md');
    expect(resolveRepoPath('sub/README.md', '../../x.md')).toBeNull();
    expect(resolveRepoPath('sub/README.md', '/../x.md')).toBeNull();
  });
});
