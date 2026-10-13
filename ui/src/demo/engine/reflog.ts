// A `logs/<ref>` file as the core reads it (reflog::read_reflog).
export interface ReflogEntry { old: string; new: string; time: number; message: string }

const OID = /^[0-9a-fA-F]{40}$/;

/** Newest first; lines that don't parse are skipped. The caller decodes the file. */
export function parseReflog(text: string): ReflogEntry[] {
  const out: ReflogEntry[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const tab = line.indexOf('\t');
    const head = tab < 0 ? line : line.slice(0, tab);
    const parts = head.split(' ');
    const [old, next] = parts;
    const time = parts.length >= 2 ? parts[parts.length - 2] : '';
    if (!OID.test(old ?? '') || !OID.test(next ?? '') || !/^[+-]?\d+$/.test(time) || !Number.isSafeInteger(Number(time))) continue;
    out.push({ old: old.toLowerCase(), new: next.toLowerCase(), time: Number(time), message: tab < 0 ? '' : line.slice(tab + 1) });
  }
  return out.reverse();
}
