// The app's Content Security Policy. Its one source is `app.security.csp` in
// crates/gitbolt-app/tauri.conf.json: Tauri sends it with every page of the bundle and adds the
// hash of each inline <script> in index.html to `script-src` itself. The e2e build (served by
// `vite preview --mode e2e`, vite.config.ts) gets the same policy as a header, with that hash
// computed here and the test harness's WebSocket added to `connect-src`, so the suite runs under
// it. Node-side only (vite.config.ts and its test).
import { createHash } from 'node:crypto';

/** Directive → its sources, as tauri.conf.json writes them (a string or a list). */
type DirectiveMap = Record<string, string | string[]>;

interface TauriConf {
  app: { security: { csp: DirectiveMap | string | null } };
}

const sources = (v: string | string[]) => (Array.isArray(v) ? v : v.split(/\s+/)).filter(Boolean);

/** The policy string from tauri.conf.json (`app.security.csp`). */
export function appCsp(conf: TauriConf): string {
  const csp = conf.app.security.csp;
  if (csp === null) throw new Error('tauri.conf.json has no Content Security Policy');
  if (typeof csp === 'string') return csp;
  return Object.entries(csp).map(([d, v]) => [d, ...sources(v)].join(' ')).join('; ');
}

/** A policy string as directive → sources. */
export function parseCsp(policy: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const part of policy.split(';')) {
    const [name, ...rest] = part.trim().split(/\s+/);
    if (name) out[name] = rest;
  }
  return out;
}

/** `'sha256-…'` of each inline classic <script> in `html`, as a browser hashes its text. */
export function inlineScriptHashes(html: string): string[] {
  return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`);
}

/** The e2e build's policy: the app's, plus `index.html`'s inline script hashes and the harness's
 * WebSocket origin (`harnessWs`, e.g. `ws://127.0.0.1:7433/ws`). */
export function e2eCsp(conf: TauriConf, html: string, harnessWs: string): string {
  const policy = parseCsp(appCsp(conf));
  policy['script-src'] = [...(policy['script-src'] ?? ["'self'"]), ...inlineScriptHashes(html)];
  policy['connect-src'] = [...(policy['connect-src'] ?? ["'self'"]), new URL(harnessWs).origin];
  return Object.entries(policy).map(([d, v]) => [d, ...v].join(' ')).join('; ');
}
