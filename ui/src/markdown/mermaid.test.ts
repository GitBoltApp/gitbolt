import { describe, expect, it } from 'vitest';
import { cleanSvg } from './mermaid';

describe('cleanSvg (spec #5 §6: Mermaid’s SVG is sanitized again)', () => {
  it('drops scripts, foreignObject, event handlers, outside references and @import', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10"><style>@import url(https://evil.example/a.css); .a{fill:url(#g)} .b{background:url(https://evil.example/x.png)}</style><script>alert(1)</script><g onclick="alert(1)"><text>A</text></g><foreignObject><div>x</div></foreignObject><image href="https://evil.example/a.png"/><use xlink:href="#ok"/><a href="javascript:alert(1)"><text>B</text></a></svg>';
    const out = cleanSvg(svg);
    expect(out).not.toMatch(/<script|onclick|foreignObject|evil\.example|javascript:|@import/i);
    expect(out).toContain('<text>A</text>');
    expect(out).toContain('<text>B</text>');
    expect(out).toContain('url(#g)');
    expect(out).toContain('xlink:href="#ok"');
  });

  it('refuses what isn’t an SVG', () => {
    expect(() => cleanSvg('<html><body>x</body></html>')).toThrow("the diagram isn't an SVG");
  });
});
