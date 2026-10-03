import { describe, expect, it } from 'vitest';
import { stashLabel } from './stashLabel';

describe('stashLabel', () => {
  it("splits git's default prefixes", () => {
    expect(stashLabel('On main: Experiment')).toEqual({ text: 'Experiment', branch: 'main' });
    expect(stashLabel('WIP on feat/x: abc123 subject')).toEqual({ text: 'abc123 subject', branch: 'feat/x' });
  });
  it('leaves other messages whole', () => {
    expect(stashLabel('just a note')).toEqual({ text: 'just a note', branch: null });
  });
});
