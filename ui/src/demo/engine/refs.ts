// A git dir's refs, read straight from its files: loose refs over packed ones, in byte order of
// their full names (the order the core's gix lists a packed repository's refs in).
import type { MemFs } from './memfs';

export interface RefFile { full: string; symref: string | null; oid: string | null }

const encoder = new TextEncoder();
const OID = /^[0-9a-f]{40}$/;

/** Byte order of two strings' UTF-8, as git and gix sort ref names (`-` sorts before `/`). */
export function compareBytes(a: string, b: string): number {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}

/** `packed-refs` lines: `<oid> <name>`; the header and the peeled `^<oid>` lines are skipped. */
export function parsePackedRefs(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split('\n')) {
    if (line.startsWith('#') || line.startsWith('^')) continue;
    const oid = line.slice(0, 40);
    const name = line.slice(41).trim();
    if (OID.test(oid) && line[40] === ' ' && name) out.set(name, oid);
  }
  return out;
}

export function readRefFiles(fs: MemFs, gitdir: string): RefFile[] {
  const byName = new Map<string, RefFile>();
  try {
    for (const [full, oid] of parsePackedRefs(fs.readFileSync(`${gitdir}/packed-refs`, 'utf8') as string)) byName.set(full, { full, symref: null, oid });
  } catch {
    // no packed refs
  }
  const walk = (dir: string, prefix: string) => {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      const path = `${dir}/${n}`;
      const full = `${prefix}/${n}`;
      if (fs.statSync(path).isDirectory()) {
        walk(path, full);
        continue;
      }
      const text = (fs.readFileSync(path, 'utf8') as string).trim();
      if (text.startsWith('ref:')) byName.set(full, { full, symref: text.slice(4).trim(), oid: null });
      else if (OID.test(text)) byName.set(full, { full, symref: null, oid: text });
    }
  };
  walk(`${gitdir}/refs`, 'refs');
  return [...byName.values()].sort((a, b) => compareBytes(a.full, b.full));
}
