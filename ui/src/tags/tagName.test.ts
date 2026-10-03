import { afterEach, describe, expect, it } from 'vitest';
import { useRuntime } from '../app/runtime';
import { tagCreateError, tagNameError } from './tagName';

afterEach(() => useRuntime.setState({ tabs: {} }));

describe('tag names (spec #3 §3.9)', () => {
  it("git's ref-name rules, said of a tag (the core's tag_name_error, word for word)", () => {
    expect(tagNameError('')).toBe('Enter a tag name');
    expect(tagNameError('a..b')).toBe("A tag name can't contain ..");
    expect(tagNameError('-x')).toBe("A tag name can't start with -");
    expect(tagNameError('v1.2.0')).toBeNull();
  });
  it('a name the loaded sidebar already has is taken', () => {
    useRuntime.setState({ tabs: { t: { sidebar: { locals: [], remotes: [], worktrees: [], stashes: [], tags: [{ name: 'v1', fullName: 'refs/tags/v1', target: 'a'.repeat(40), time: 0 }] } } as never } });
    expect(tagCreateError('t', 'v1')).toBe('A tag named v1 already exists');
    expect(tagCreateError('t', 'v2')).toBeNull();
  });
});
