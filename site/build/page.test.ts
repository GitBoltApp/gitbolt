import { expect, test } from 'vitest';
import { esc, fillMarkers } from './page.ts';

test('each <!--name:arg--> is filled by its marker; ordinary comments stay', () => {
  const html = '<p><!--release:version--></p><!-- a note --><div><!--readme:groups--></div>';
  const out = fillMarkers(html, { release: (a) => `v:${a}`, readme: (a) => `<ul>${a}</ul>` });
  expect(out).toBe('<p>v:version</p><!-- a note --><div><ul>groups</ul></div>');
});

test('a marker nothing fills fails the build, naming it', () => {
  expect(() => fillMarkers('<!--hero:still-->', {})).toThrow('index.html: nothing fills <!--hero:still-->');
});

test('esc makes text safe in elements and attributes', () => {
  expect(esc('<a href="x">&</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
});
