import type { Eol } from '../api/gen/Eol';

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function eolLabel(eol: Eol | undefined): string {
  return eol === 'crlf' ? 'CRLF' : eol === 'lf' ? 'LF' : eol === 'mixed' ? 'mixed' : 'none';
}
