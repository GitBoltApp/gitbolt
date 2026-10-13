import { describe, expect, it } from 'vitest';
import { blameSummary, coAuthors, commitMessage, gitSubject, parseCommit, parseOid, readCommit } from './commitText';
import { makeTestRepo } from './testkit';

const P1 = '1111111111111111111111111111111111111111';
const P2 = '2222222222222222222222222222222222222222';
const raw = (headers: string, msg: Uint8Array | string) => {
  const head = new TextEncoder().encode(`tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\nparent ${P1}\nparent ${P2}\nauthor Ada Q. Lovelace <ada@example.com> 1700000000 +0100\ncommitter Grace Hopper <grace@example.com> 1700000600 -0500\n${headers ? `${headers}\n` : ''}\n`);
  const body = typeof msg === 'string' ? new TextEncoder().encode(msg) : msg;
  const out = new Uint8Array(head.length + body.length);
  out.set(head);
  out.set(body, head.length);
  return out;
};

describe('commit text', () => {
  it('parses headers, summary and body', () => {
    const c = parseCommit(raw('', 'Fix the thing\n\nLonger explanation\nsecond line\n'));
    expect(c.parents).toEqual([P1, P2]);
    expect([c.author.name, c.author.email, c.author.time, c.committer.time]).toEqual(['Ada Q. Lovelace', 'ada@example.com', 1_700_000_000, 1_700_000_600]);
    expect([c.summary, c.body, c.signed]).toEqual(['Fix the thing', 'Longer explanation\nsecond line', false]);
    expect(c.tree).toBe('4b825dc642cb6eb9a060e54bf8d69288fbee4904');
  });

  it('normalises CRLF, trims the end, and reads a signature header and its continuation lines', () => {
    const c = parseCommit(raw('gpgsig -----BEGIN PGP SIGNATURE-----\n abc\n -----END PGP SIGNATURE-----', 'Title\r\n\r\nBody\r\n\r\n'));
    expect([c.summary, c.body, c.message, c.signed]).toEqual(['Title', 'Body', 'Title\n\nBody', true]);
  });

  it("trims as Rust does: a byte-order mark at either end of a line is text, not whitespace", () => {
    const c = parseCommit(raw('', '\uFEFFTitle\uFEFF\n\n\uFEFFBody\uFEFF\u3000\n'));
    expect([c.summary, c.body, c.message]).toEqual(['\uFEFFTitle\uFEFF', '\uFEFFBody\uFEFF', '\uFEFFTitle\uFEFF\n\n\uFEFFBody\uFEFF']);
    expect(commitMessage(c, P1).body).toBe('\uFEFFBody\uFEFF');
    expect(coAuthors('Co-authored-by: \uFEFFLars <lars@example.com>')).toEqual([{ name: '\uFEFFLars', email: 'lars@example.com' }]);
  });

  it('decodes the message and names in the declared encoding', () => {
    const latin = new Uint8Array([0x43, 0x61, 0x66, 0xe9, 0x0a]);
    expect(parseCommit(raw('encoding ISO-8859-1', latin)).summary).toBe('Café');
    expect(parseCommit(raw('', latin)).summary).toBe('Café');
  });

  it('keeps a multi-line first paragraph in the message body, joins it for %s', () => {
    const c = parseCommit(raw('', 'One\ntwo  \n\nRest\n'));
    expect(commitMessage(c, P1.toUpperCase())).toEqual({ id: P1, summary: 'One', body: 'two  \n\nRest' });
    expect(gitSubject('\n\nOne\ntwo  \n\nRest\n')).toBe('One two');
    expect(blameSummary('\n  \nFirst line  \nsecond', P1)).toBe('First line  ');
    expect(blameSummary('', P1)).toBe(`(${P1})`);
  });

  it('reads co-author trailers case-insensitively, once per email', () => {
    const msg = 'Fix\n\nBody\n\nCo-authored-by: Maren Holt <maren@example.com>\nco-authored-by: Lars Tidemann <lars@example.com>\nCO-AUTHORED-BY: Dup <MAREN@example.com>\nSigned-off-by: X <x@y>\n';
    expect(coAuthors(msg)).toEqual([{ name: 'Maren Holt', email: 'maren@example.com' }, { name: 'Lars Tidemann', email: 'lars@example.com' }]);
    expect(coAuthors('Co-authored-by: nobody')).toEqual([]);
  });

  it('accepts only full hex ids', () => {
    expect(parseOid(P1.toUpperCase())).toBe(P1);
    expect(() => parseOid('abc')).toThrow();
    expect(() => parseOid('--output=/tmp/x')).toThrowError(expect.objectContaining({ kind: 'InvalidInput', message: 'not a full object id: "--output=/tmp/x"' }));
  });

  it('reads a commit from the repository, and says why it can\'t', async () => {
    const t = await makeTestRepo();
    await t.write('a.txt', 'a\n');
    const c = await t.commit('Add a');
    expect((await readCommit(t.repo, c)).summary).toBe('Add a');
    await expect(readCommit(t.repo, P1)).rejects.toMatchObject({ kind: 'NotFound', message: `no such commit: ${P1}` });
    const tree = (await readCommit(t.repo, c)).tree;
    await expect(readCommit(t.repo, tree)).rejects.toMatchObject({ kind: 'InvalidInput', message: `not a commit: ${tree}` });
  });
});
