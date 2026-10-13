// The page's generated parts: index.html marks each with a comment, <!--name:arg-->, which the
// build and the dev server fill in before Vite processes the page's assets (so a generated <img>
// is hashed and copied like any other). Node-side only.
import type { Plugin } from 'vite';

export type Marker = (arg: string) => string;

export const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** `html` with each `<!--name:arg-->` replaced by `markers[name](arg)`; one nothing fills fails. */
export function fillMarkers(html: string, markers: Record<string, Marker>): string {
  return html.replace(/<!--([a-z]+):([a-z0-9-]+)-->/g, (whole, name: string, arg: string) => {
    const fill = markers[name];
    if (!fill) throw new Error(`index.html: nothing fills ${whole}`);
    return fill(arg);
  });
}

export function page(markers: Record<string, Marker>): Plugin {
  return { name: 'gitbolt-site-page', transformIndexHtml: { order: 'pre', handler: (html) => fillMarkers(html, markers) } };
}
