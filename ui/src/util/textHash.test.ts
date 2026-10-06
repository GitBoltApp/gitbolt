import { describe, expect, it } from 'vitest';
import { textKey } from './textHash';

describe('textKey', () => {
  it('is the same for the same text, and differs for an edit that keeps the length', () => {
    expect(textKey('# Guide\n\nRun it once.\n')).toBe(textKey('# Guide\n\nRun it once.\n'));
    expect(textKey('# Guide\n\nRun it once.\n')).not.toBe(textKey('# Guide\n\nRun it twice\n'));
    expect(textKey('ab')).not.toBe(textKey('ba'));
    expect(textKey('')).toMatch(/^0:/);
  });

  it('stays short for a long text', () => {
    expect(textKey('x'.repeat(1_000_000)).length).toBeLessThan(30);
  });
});
