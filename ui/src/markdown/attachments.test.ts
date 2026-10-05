import { describe, expect, it } from 'vitest';
import { signedAttachments } from './attachments';

const A = '1b2c3d4e-0000-4000-8000-00000000000a';
const B = '1b2c3d4e-0000-4000-8000-00000000000b';
const att = (u: string) => `https://github.com/user-attachments/assets/${u}`;
const signed = (n: number, u: string) => `https://private-user-images.githubusercontent.com/583231/${n}-${u}.png?jwt=eyJ.x.y`;

describe('GitHub’s signed attachment URLs (spec #5 §4.2)', () => {
  it('maps each attachment to the signed URL carrying its id', () => {
    const body = `![a](${att(A)})\n\n![b](${att(B)})\n\nagain ![a](${att(A)})`;
    const html = `<p><a href="${signed(2, B)}"><img src="${signed(2, B)}"></a><a href="${signed(1, A)}"><img src="${signed(1, A)}"></a></p>`;
    expect(signedAttachments(body, html)).toBe(`![a](${signed(1, A)})\n\n![b](${signed(2, B)})\n\nagain ![a](${signed(1, A)})`);
  });

  it('falls back to document order when the signed URLs don’t carry the id, and unescapes &amp;', () => {
    const body = `![a](${att(A)}) ![b](${att(B)})`;
    const html = '<img src="https://private-user-images.githubusercontent.com/1/x.png?jwt=one&amp;v=1"><img src="https://private-user-images.githubusercontent.com/1/y.png?jwt=two">';
    expect(signedAttachments(body, html)).toBe('![a](https://private-user-images.githubusercontent.com/1/x.png?jwt=one&v=1) ![b](https://private-user-images.githubusercontent.com/1/y.png?jwt=two)');
  });

  it('never rewrites a URL inside code: a fenced block (``` or ~~~) or an inline span', () => {
    const body = [
      'Paste this:',
      '```md',
      `![a](${att(A)})`,
      '```',
      `Or \`${att(B)}\` inline, or \`\` ${att(A)} \`\`.`,
      '~~~~',
      `${att(B)}`,
      '~~~',
      'still code',
      '~~~~',
      `Shown: ![b](${att(B)})`,
    ].join('\n');
    // Without ids in the signed URLs: document order, which must skip the URLs in code.
    const html = '<img src="https://private-user-images.githubusercontent.com/1/x.png?jwt=one">';
    const out = signedAttachments(body, html);
    expect(out).toBe(body.replace(`Shown: ![b](${att(B)})`, 'Shown: ![b](https://private-user-images.githubusercontent.com/1/x.png?jwt=one)'));
  });

  it('a fence never closed runs to the end; a backtick line with more backticks is no fence', () => {
    const body = `\`\`\`js \`x\`\n![a](${att(A)})\n\n\`\`\`\n${att(B)}`;
    const html = `<img src="${signed(1, A)}"><img src="${signed(2, B)}">`;
    expect(signedAttachments(body, html)).toBe(`\`\`\`js \`x\`\n![a](${signed(1, A)})\n\n\`\`\`\n${att(B)}`);
  });

  it('changes nothing without body_html or attachments', () => {
    expect(signedAttachments(`![a](${att(A)})`, null)).toBe(`![a](${att(A)})`);
    expect(signedAttachments('no images', '<p>no images</p>')).toBe('no images');
  });
});
