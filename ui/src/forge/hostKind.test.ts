import { describe, expect, it } from 'vitest';
import { detectHostKind, HOST_KIND_NAMES } from './hostKind';

describe('detectHostKind (the Rust host_kind)', () => {
  it('knows GitHub, GitLab and any host with gitlab in a label', () => {
    expect(detectHostKind('github.com')).toBe('github');
    expect(detectHostKind('GitLab.com')).toBe('gitlab');
    expect(detectHostKind('gitlab.example.org')).toBe('gitlab');
    expect(detectHostKind('code.example.com')).toBe('generic');
    expect(HOST_KIND_NAMES.generic).toBe('Generic');
  });
});
