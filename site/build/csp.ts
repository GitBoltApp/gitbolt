// The site's Content Security Policy, a <meta> in index.html (GitHub Pages sends no headers):
// everything from the site's own origin, nothing inline, no other host (website spec §2 decision 9).
// The demo's frame carries its own policy (ui/src/security/csp.ts, demoCsp).
import type { Plugin } from 'vite';

export const SITE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'none'",
  "frame-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join('; ');

export function sitePolicy(): Plugin {
  return {
    name: 'gitvolt-site-csp',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler: (html) => html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${SITE_CSP}" />`),
    },
  };
}
