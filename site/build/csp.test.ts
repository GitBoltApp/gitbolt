import type { IndexHtmlTransformContext } from 'vite';
import { expect, test } from 'vitest';
import { SITE_CSP, sitePolicy } from './csp.ts';

test('the policy allows the site itself only: nothing inline, no other host, no data: URIs', () => {
  expect(SITE_CSP).not.toMatch(/unsafe|https?:|data:|\*/);
  expect(SITE_CSP.split('; ')).toEqual([
    "default-src 'none'", "script-src 'self'", "style-src 'self'", "img-src 'self'", "font-src 'self'",
    "connect-src 'none'", "frame-src 'self'", "base-uri 'none'", "form-action 'none'", "object-src 'none'",
  ]);
});

test('the build puts it first in <head>', () => {
  const hook = sitePolicy().transformIndexHtml as { handler: (html: string, ctx: IndexHtmlTransformContext) => string };
  const out = hook.handler('<!doctype html><html><head><title>x</title></head></html>', {} as IndexHtmlTransformContext);
  expect(out).toContain(`<head>\n    <meta http-equiv="Content-Security-Policy" content="${SITE_CSP}" /><title>`);
});
