import { describe, expect, it } from 'vitest';
import { forgeReadHandlers as r } from '../handlers/forgeReads';
import { forgeWriteHandlers as w } from '../handlers/forgeWrites';
import { labCtx } from './testkit';

describe('the demo forge: notes and reviews', () => {
  it("a reply joins its thread as the visitor, at the fake's write time", async () => {
    const { ctx, id } = await labCtx();
    const n = await w.forgeReply({ repo: id, number: 1, discussion: 'd2', body: 'Done, thanks.' }, ctx);
    expect(n).toMatchObject({ id: '1001', author: { username: 'you' }, body: 'Done, thanks.', createdAt: 1_791_117_000, system: false });
    const ds = (await r.forgeMrDiscussions({ repo: id, number: 1 }, ctx)).value;
    expect(ds.find((d) => d.id === 'd2')!.notes.map((x) => x.body)).toContain('Done, thanks.');
    await expect(w.forgeReply({ repo: id, number: 1, discussion: null, body: '  ' }, ctx)).rejects.toMatchObject({ message: 'Write a reply first' });
  });

  it('reactions add and come off, mine marked', async () => {
    const { ctx, id } = await labCtx();
    const on = await w.forgeReact({ repo: id, number: 1, note: { discussion: 'd2', note: '102' }, name: 'thumbsup', on: true }, ctx);
    expect(on).toEqual([{ name: 'thumbsup', count: 2, mine: true, users: ['Grace Hopper', 'You'] }]);
    const off = await w.forgeReact({ repo: id, number: 1, note: { discussion: 'd2', note: '102' }, name: 'thumbsup', on: false }, ctx);
    expect(off).toEqual([{ name: 'thumbsup', count: 1, mine: false, users: ['Grace Hopper'] }]);
    await expect(w.forgeReact({ repo: id, number: 1, note: { discussion: 'd2', note: '102' }, name: 'Thumbs Up', on: true }, ctx)).rejects.toMatchObject({ message: "That isn't an emoji name" });
  });

  it("another's note can't be edited or deleted", async () => {
    const { ctx, id } = await labCtx();
    await expect(w.forgeEditNote({ repo: id, number: 1, note: { discussion: 'd1', note: '101' }, body: 'x' }, ctx)).rejects.toMatchObject({ kind: 'AuthFailed', message: 'gitlab.example.com refused: 403 Forbidden' });
    await expect(w.forgeDeleteNote({ repo: id, number: 1, note: { discussion: 'd1', note: '101' } }, ctx)).rejects.toMatchObject({ kind: 'AuthFailed' });
    const mine = await w.forgeReply({ repo: id, number: 1, discussion: null, body: 'Mine' }, ctx);
    expect((await w.forgeEditNote({ repo: id, number: 1, note: { discussion: `d${mine.id}`, note: mine.id }, body: 'Mine, edited' }, ctx)).body).toBe('Mine, edited');
    await expect(w.forgeEditNote({ repo: id, number: 1, note: { discussion: `d${mine.id}`, note: mine.id }, body: ' ' }, ctx)).rejects.toMatchObject({ message: "A comment can't be empty: delete it instead" });
    await w.forgeDeleteNote({ repo: id, number: 1, note: { discussion: `d${mine.id}`, note: mine.id } }, ctx);
    const ds = (await r.forgeMrDiscussions({ repo: id, number: 1 }, ctx)).value;
    expect(ds.some((d) => d.id === `d${mine.id}`)).toBe(false);
  });

  it('resolve and unresolve a thread; approve makes it mergeable; request changes withdraws it', async () => {
    const { ctx, id } = await labCtx();
    expect(await w.forgeResolve({ repo: id, number: 1, discussion: 'd2', resolved: true }, ctx)).toEqual({ resolved: true, resolvedBy: 'You' });
    await expect(w.forgeResolve({ repo: id, number: 1, discussion: 'd1', resolved: true }, ctx)).rejects.toMatchObject({ kind: 'Other' });
    await w.forgeApprove({ repo: id, number: 1 }, ctx);
    expect((await r.forgeMrDetail({ repo: id, number: 1 }, ctx)).value).toMatchObject({ mergeStatus: { kind: 'mergeable' }, mr: { review: { decision: 'approved', approvals: 1 } } });
    expect(await w.forgeReview({ repo: id, number: 1, review: { event: 'requestChanges', body: 'One more thing.' } }, ctx)).toEqual({ fallback: false });
    expect((await r.forgeMrDetail({ repo: id, number: 1 }, ctx)).value.mergeStatus).toEqual({ kind: 'blocked', reason: 'It needs approval first' });
    expect(await w.forgeSetSubscribed({ repo: id, number: 1, on: false }, ctx)).toBe(false);
    expect(await w.forgeSetSubscribed({ repo: id, number: 1, on: false }, ctx)).toBe(false);
    expect(await w.forgeSetSubscribed({ repo: id, number: 1, on: true }, ctx)).toBe(true);
  });

  it('a write forgets the kept lists; a reaction does not', async () => {
    const { ctx, id } = await labCtx();
    await r.forgeMrList({ repo: id, filter: 'all' }, ctx);
    await w.forgeReact({ repo: id, number: 1, note: { discussion: 'd2', note: '102' }, name: 'tada', on: true }, ctx);
    expect((await r.forgeCachedMrs({ repo: id, refs: [], filter: 'all' }, ctx))?.list).not.toBeNull();
    await w.forgeApprove({ repo: id, number: 1 }, ctx);
    expect(await r.forgeCachedMrs({ repo: id, refs: [], filter: 'all' }, ctx)).toBeNull();
    await expect(w.forgeReview({ repo: id, number: 1, review: { event: 'comment', body: ' ' } }, ctx)).rejects.toMatchObject({ message: 'Write a comment first' });
  });
});
