import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

/**
 * A large generated repo for the graph perf probe (graph-scroll-perf.spec.ts): `commits` commits
 * on `branches` long-lived branches that interleave (so the graph keeps about `branches` lanes the
 * whole way down), merging into main now and then, with `authors` fictional authors and a tag
 * every 150 commits. Built with one `git fast-import` (a second or two), deterministic.
 */
export function makePerfRepo(dir: string, { commits = 4000, branches = 22, authors = 60 } = {}): string {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  let seed = 12345;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const out: string[] = [];
  let mark = 0;
  let time = 1_700_000_000;
  const tips = new Map<string, number>();
  const commit = (branch: string, msg: string, from: number | undefined, merge?: number) => {
    const a = Math.floor(rand() * authors);
    const who = `Dev Person${a} <dev${a}@example.com> ${(time += 60)} +0000`;
    const data = Buffer.from(msg);
    out.push(`commit refs/heads/${branch}`, `mark :${++mark}`, `author ${who}`, `committer ${who}`, `data ${data.length}`, msg);
    if (from !== undefined) out.push(`from :${from}`);
    if (merge !== undefined) out.push(`merge :${merge}`);
    if (mark === 1) out.push('M 644 inline README', 'data 6', 'hello');
    out.push('');
    tips.set(branch, mark);
    return mark;
  };
  commit('main', 'Initial commit', undefined);
  const names = Array.from({ length: branches - 1 }, (_, i) => `feature/b${i + 1}`);
  for (const b of names) commit(b, `Start ${b}`, tips.get('main'));
  for (let n = 0; tips.size && mark < commits; n++) {
    const r = rand();
    if (r < 0.05) {
      const b = names[Math.floor(rand() * names.length)];
      commit('main', `Merge branch '${b}'`, tips.get('main'), tips.get(b));
    } else {
      const b = r < 0.2 ? 'main' : names[Math.floor(rand() * names.length)];
      commit(b, `Change ${n} in area ${Math.floor(rand() * 40)}`, tips.get(b));
    }
    if (mark % 150 === 0) out.push(`reset refs/tags/v0.${mark / 150}`, `from :${mark}`, '');
  }
  execFileSync('git', ['-C', dir, 'fast-import', '--quiet'], { input: out.join('\n') + '\n' });
  execFileSync('git', ['-C', dir, 'reset', '-q', '--hard', 'main']);
  return dir;
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b: Buffer) => {
  let c = 0xffffffff;
  for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

/** An `size`×`size` opaque PNG: a diagonal gradient in a colour picked from `key` (a fictional
 * author's avatar for the probe), base64. */
export function avatarPng(key: string, size = 80): string {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const [r, g, b] = [h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff];
  const raw = Buffer.alloc(size * (1 + size * 3));
  for (let y = 0; y < size; y++) {
    const row = y * (1 + size * 3);
    for (let x = 0; x < size; x++) {
      const t = (x + y) / (2 * size);
      raw[row + 1 + x * 3] = r * t;
      raw[row + 2 + x * 3] = g * (1 - t);
      raw[row + 3 + x * 3] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  return png.toString('base64');
}
