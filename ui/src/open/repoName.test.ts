import { describe, expect, it } from 'vitest';
import { repoNameFromUrl } from './repoName';

describe('repoNameFromUrl', () => {
  it('takes the last path segment without .git', () => {
    expect(repoNameFromUrl('https://gitlab.example.com/acme/shop.git')).toBe('shop');
    expect(repoNameFromUrl('git@github.com:owner/repo.git')).toBe('repo');
    expect(repoNameFromUrl('ssh://git@gitlab.com:2222/a/b/c')).toBe('c');
    expect(repoNameFromUrl('file:///tmp/x/origin.git/')).toBe('origin');
    expect(repoNameFromUrl('  ')).toBe('');
  });
});
