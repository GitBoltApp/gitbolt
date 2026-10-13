import { expect, test } from 'vitest';
import { hostKind, mismatchedUpstream, parseRemoteUrl, redact, remoteFor, remoteId, trackingRef } from './remotes';

test('parseRemoteUrl (remotes::parse_remote_url)', () => {
  const p = (u: string) => { const r = parseRemoteUrl(u); return r && [r.host, r.path]; };
  expect(p('https://gitlab.example.com/Acme/shop.git')).toEqual(['gitlab.example.com', 'Acme/shop']);
  expect(p('git@github.com:owner/repo.git')).toEqual(['github.com', 'owner/repo']);
  expect(p('ssh://git@gitlab.com:2222/a/b/c.git')).toEqual(['gitlab.com', 'a/b/c']);
  expect(p('https://user:tok@GitHub.com/o/r/')).toEqual(['github.com', 'o/r']);
  expect(p('/demo/.origins/basic.git')).toBeNull();
  expect(p('file:///tmp/origin.git')).toBeNull();
  expect(p('./relative')).toBeNull();
});

test('hostKind and remoteId', () => {
  expect([hostKind('github.com'), hostKind('api.github.com'), hostKind('gitlab.example.com'), hostKind('gitlab.com'), hostKind('example.com')]).toEqual(['github', 'github', 'gitlab', 'gitlab', 'generic']);
  expect(remoteId('https://gitlab.example.com/Acme/Shop.git')).toBe('gitlab.example.com/acme/shop');
  expect(remoteId('/demo/.origins/basic.git/')).toBe('/demo/.origins/basic');
});

test('redact (redact::redact)', () => {
  expect(redact('https://oauth2:glpat-FAKE-00000000000000000000@gitlab.example.com/a/b.git')).toBe('https://***@gitlab.example.com/a/b.git');
  expect(redact('ssh://git@gitlab.example.com/a/b.git')).toBe('ssh://git@gitlab.example.com/a/b.git');
  expect(redact('ftp://user:pass@host/x')).toBe('ftp://***@host/x');
  expect(redact('https://h/x?private_token=abc&y=1')).toBe('https://h/x?private_token=***&y=1');
  expect(redact('token glpat-FAKE-00000000000000000000 here')).toBe('token *** here');
  expect(redact('/demo/.origins/basic.git')).toBe('/demo/.origins/basic.git');
});

test('remoteFor, mismatchedUpstream, trackingRef', () => {
  expect(remoteFor('my/fork/main', ['my', 'my/fork', 'origin'])).toBe('my/fork');
  expect(remoteFor('origin', ['origin'])).toBeNull();
  expect(mismatchedUpstream('feature/a', 'origin', 'refs/heads/feature/b')).toBe('origin/feature/b');
  expect(mismatchedUpstream('main', 'my/fork', 'refs/heads/main')).toBeNull();
  expect(mismatchedUpstream('main', '.', 'refs/heads/dev')).toBeNull();
  expect(mismatchedUpstream('main', '', '')).toBeNull();
  expect(trackingRef(['+refs/heads/*:refs/remotes/origin/*'], 'refs/heads/main')).toBe('refs/remotes/origin/main');
  expect(trackingRef(['^refs/heads/x', 'refs/heads/main:refs/remotes/o/trunk'], 'refs/heads/main')).toBe('refs/remotes/o/trunk');
  expect(trackingRef(['refs/heads/main:'], 'refs/heads/main')).toBeNull();
  expect(trackingRef(['+refs/heads/*:refs/remotes/origin/*'], 'refs/tags/v1')).toBeNull();
});

test('redact: a Unicode letter before a scheme is a word character (Rust `\\b`)', () => {
  expect(redact('éhttps://user@h/x')).toBe('éhttps://user@h/x');
  expect(redact('see https://user@h/x')).toBe('see https://***@h/x');
  expect(redact('HTTPS://TOKEN@H/x')).toBe('HTTPS://***@H/x');
});

test('trackingRef: a `$` in a captured branch name stays literal; remote ids lowercase ASCII only', () => {
  expect(trackingRef(['refs/heads/*:refs/remotes/o/*'], 'refs/heads/$&x')).toBe('refs/remotes/o/$&x');
  expect(remoteId('https://Gitlab.Example.com/Ünï/Shop.git')).toBe('gitlab.example.com/Ünï/shop');
});
