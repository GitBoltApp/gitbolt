import { describe, expect, it } from 'vitest';
import { eolLabel, formatBytes } from './format';

describe('format', () => {
  it('formats sizes and line endings', () => {
    expect([formatBytes(undefined), formatBytes(null), formatBytes(9), formatBytes(2048), formatBytes(2_160_000)]).toEqual(['—', '—', '9 B', '2.0 KB', '2.1 MB']);
    expect([eolLabel('crlf'), eolLabel('lf'), eolLabel('mixed'), eolLabel('none'), eolLabel(undefined)]).toEqual(['CRLF', 'LF', 'mixed', 'none', 'none']);
  });
});
