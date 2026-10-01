import { describe, expect, it } from 'vitest';
import { cloneDestProblem, cloneUrlProblem } from './cloneInput';

describe('cloneUrlProblem', () => {
  it('accepts the supported forms', () => {
    for (const u of ['https://h/a/b.git', 'http://h/a', 'ssh://git@h:2222/a/b', 'git://h/a.git', 'file:///tmp/o.git', 'git@github.com:o/r.git', '/tmp/x/origin.git', '']) {
      expect(cloneUrlProblem(u), u).toBeNull();
    }
  });
  it('rejects anything else', () => {
    for (const u of ['hello', 'ext::sh -c x', '-oProxyCommand=x', 'relative/path', 'https://', 'ftp://h/a', '/']) {
      expect(cloneUrlProblem(u), u).not.toBeNull();
    }
  });
});

describe('cloneDestProblem', () => {
  it('requires an absolute path', () => {
    expect(cloneDestProblem('/home/u/r')).toBeNull();
    expect(cloneDestProblem('')).toBeNull();
    expect(cloneDestProblem('rel/dir')).not.toBeNull();
  });
});
