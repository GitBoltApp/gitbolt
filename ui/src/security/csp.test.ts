import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { appCsp, e2eCsp, inlineScriptHashes, parseCsp } from './csp';

const ui = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const tauriConf = JSON.parse(readFileSync(join(ui, '..', 'crates', 'gitbolt-app', 'tauri.conf.json'), 'utf8'));
const indexHtml = readFileSync(join(ui, 'index.html'), 'utf8');

describe('the Content Security Policy (tauri.conf.json, the one source)', () => {
  const policy = parseCsp(appCsp(tauriConf));

  it('is strict: only the app bundle runs, nothing embeds or is embedded, nothing posts', () => {
    expect(policy['default-src']).toEqual(["'self'"]);
    expect(policy['script-src']).toEqual(["'self'", "'wasm-unsafe-eval'"]);
    for (const d of ['object-src', 'base-uri', 'frame-ancestors', 'form-action']) expect(policy[d], d).toEqual(["'none'"]);
    const all = Object.values(policy).flat();
    expect(all).not.toContain("'unsafe-eval'");
    expect(all.filter((s) => s === "'unsafe-inline'")).toHaveLength(1);
    expect(policy['style-src']).toContain("'unsafe-inline'");
  });

  it('loads images only from the bundle, data: and blob: (the core fetches every remote picture)', () => {
    expect(policy['img-src']).toEqual(["'self'", 'data:', 'blob:']);
  });

  it('plays media only from the bundle and blob: (a Markdown video, from the bytes the core fetched)', () => {
    expect(policy['media-src']).toEqual(["'self'", 'blob:']);
  });

  it('connects only to the bundle and the app IPC', () => {
    expect(policy['connect-src']).toEqual(["'self'", 'ipc:', 'http://ipc.localhost']);
  });

  it("the e2e build gets the same policy, plus the harness's WebSocket and index.html's inline script hash (Tauri adds that hash itself)", () => {
    const e2e = parseCsp(e2eCsp(tauriConf, indexHtml, 'ws://127.0.0.1:9060/ws'));
    const script = indexHtml.match(/<script id="theme-first-paint">([\s\S]*?)<\/script>/)![1];
    const hash = `'sha256-${createHash('sha256').update(script).digest('base64')}'`;
    expect(inlineScriptHashes(indexHtml)).toEqual([hash]);
    expect(e2e['script-src']).toEqual([...policy['script-src'], hash]);
    expect(e2e['connect-src']).toEqual([...policy['connect-src'], 'ws://127.0.0.1:9060']);
    for (const d of Object.keys(policy).filter((d) => d !== 'script-src' && d !== 'connect-src')) expect(e2e[d], d).toEqual(policy[d]);
  });
});
