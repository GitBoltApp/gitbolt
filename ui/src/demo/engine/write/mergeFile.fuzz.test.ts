import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mergeTexts, type MergeStyle } from './mergeFile';

const LINES = ['alpha\n', 'beta\n', 'gamma\n', 'delta\n', '\n', '}\n', 'x\r\n', 'k1\n', 'k2\n', 'k3\n', 'omega\n', 'end'];

/** mulberry32: the same cases on every run. */
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mutate(lines: string[], r: () => number): string[] {
  const out = [...lines];
  for (let k = Math.floor(r() * 3); k >= 0; k--) {
    const at = Math.floor(r() * (out.length + 1));
    const pick = LINES[Math.floor(r() * (LINES.length - 1))];
    const op = r();
    if (op < 0.4 && at < out.length) out[at] = pick;
    else if (op < 0.7 && at < out.length) out.splice(at, 1);
    else out.splice(at, 0, pick);
  }
  return out;
}

const text = (lines: string[]) => lines.join('').replace(/end(?=.)/g, 'end\n');

describe.skipIf(!process.env.GITVOLT_MERGE_FUZZ)('mergeTexts against git merge-file', () => {
  it('matches git on random small inputs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gb-merge-fuzz-'));
    const r = rng(20261013);
    let exact = 0;
    let counts = 0;
    const misses: string[] = [];
    const N = 600;
    try {
      for (let n = 0; n < N; n++) {
        const base = Array.from({ length: Math.floor(r() * 9) }, () => LINES[Math.floor(r() * LINES.length)]);
        const [b, o, t] = [text(base), text(mutate(base, r)), text(mutate(base, r))];
        for (const style of ['merge', 'diff3'] as MergeStyle[]) {
          writeFileSync(join(dir, 'o'), o, 'latin1');
          writeFileSync(join(dir, 'b'), b, 'latin1');
          writeFileSync(join(dir, 't'), t, 'latin1');
          const git = spawnSync('git', ['merge-file', '-p', ...(style === 'diff3' ? ['--diff3'] : []), '-L', 'ours', '-L', 'base', '-L', 'theirs', 'o', 'b', 't'], { cwd: dir });
          const want = git.stdout.toString('latin1');
          const got = mergeTexts(b, o, t, style, { ours: 'ours', base: 'base', theirs: 'theirs' });
          if (got.text === want) exact++;
          else if (misses.length < 8) misses.push(JSON.stringify({ style, b, o, t, want, got: got.text }));
          if (got.conflicts === (git.status ?? -1)) counts++;
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    console.log(`exact ${exact}/${2 * N}, conflict counts ${counts}/${2 * N}\n${misses.join('\n')}`);
    expect(counts / (2 * N)).toBeGreaterThanOrEqual(0.99);
    expect(exact / (2 * N)).toBeGreaterThanOrEqual(0.97);
  });
});
