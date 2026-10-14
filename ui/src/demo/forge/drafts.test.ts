import { describe, expect, it } from 'vitest';
import { forgeReadHandlers as r } from '../handlers/forgeReads';
import { forgeWriteHandlers as w } from '../handlers/forgeWrites';
import { labCtx } from './testkit';

const refs = { baseSha: 'b'.repeat(40), startSha: 'b'.repeat(40), headSha: '1'.repeat(40) };
const added = (newLine: number) => ({ kind: 'added' as const, oldLine: 6, newLine });
const on = (end: ReturnType<typeof added>, start: ReturnType<typeof added> | null = null, body = 'x') => ({ anchor: { path: 'src/hud.rs', oldPath: 'src/hud.rs', start, end }, body, refs });

describe('the demo forge: drafts', () => {
  it('the review diff names the lines that take a comment', async () => {
    const { ctx, id } = await labCtx();
    const d = await w.forgeReviewDiff({ repo: id, number: 1 }, ctx);
    expect(d.refs).toEqual(refs);
    expect(d.files[0]).toMatchObject({ path: 'src/hud.rs', oldPath: 'src/hud.rs', tooLarge: false });
    expect(d.files[0].lines.filter((l) => l.kind === 'added').map((l) => l.newLine)).toEqual([6, 7, 8, 9, 10]);
  });

  it('a draft on a line, a range, then submit publishes them as threads with the event', async () => {
    const { ctx, id } = await labCtx();
    const one = await w.forgeAddDraft({ repo: id, number: 1, comment: on(added(8), null, 'Round here?') }, ctx);
    expect(one).toMatchObject({ body: 'Round here?', position: { path: 'src/hud.rs', line: 8 }, replyTo: null });
    await w.forgeAddDraft({ repo: id, number: 1, comment: on(added(9), added(7), 'And these.') }, ctx);
    const pending = await w.forgeReviewDrafts({ repo: id, number: 1 }, ctx);
    expect(pending.drafts).toHaveLength(2);
    expect(pending).toMatchObject({ refs, canDraft: true, pendingReview: null });
    await expect(w.forgeAddDraft({ repo: id, number: 1, comment: on(added(99)) }, ctx)).rejects.toMatchObject({ kind: 'InvalidInput', message: "GitLab won't take a comment on that line: line code can't be blank, must be a valid line code" });
    const out = await w.forgeSubmitReview({ repo: id, number: 1, review: { event: 'approve', body: 'Ship it.' } }, ctx);
    expect(out).toEqual({ published: 2, eventError: null, bodyPosted: true, eventSent: true, fallback: false });
    const ds = (await r.forgeMrDiscussions({ repo: id, number: 1 }, ctx)).value;
    expect(ds.filter((d) => d.notes[0].author.username === 'you').map((d) => d.notes[0].body)).toEqual(['Round here?', 'And these.', 'Ship it.']);
    expect((await w.forgeReviewDrafts({ repo: id, number: 1 }, ctx)).drafts).toEqual([]);
  });

  it('edit, delete, discard, and comment at once', async () => {
    const { ctx, id } = await labCtx();
    const d = await w.forgeAddDraft({ repo: id, number: 1, comment: on(added(8), null, 'a') }, ctx);
    expect(await w.forgeEditDraft({ repo: id, number: 1, id: d.id, body: 'b' }, ctx)).toMatchObject({ body: 'b', position: null });
    await w.forgeDeleteDraft({ repo: id, number: 1, id: d.id }, ctx);
    await w.forgeAddDraft({ repo: id, number: 1, comment: on(added(8), null, 'c') }, ctx);
    expect(await w.forgeDiscardReview({ repo: id, number: 1 }, ctx)).toBe(1);
    const t = await w.forgeCommentNow({ repo: id, number: 1, comment: on(added(8), null, 'Now.') }, ctx);
    expect(t).toMatchObject({ resolvable: true, notes: [{ body: 'Now.', position: { line: 8 } }] });
  });

  it('checks come first, an empty review needs a message, a bad draft id is refused', async () => {
    const { ctx, id } = await labCtx();
    await expect(w.forgeAddDraft({ repo: id, number: 1, comment: on(added(8), null, ' ') }, ctx)).rejects.toMatchObject({ message: 'Write a comment first' });
    await expect(w.forgeSubmitReview({ repo: id, number: 1, review: { event: 'comment', body: '' } }, ctx)).rejects.toMatchObject({ message: 'Write a comment first' });
    await expect(w.forgeDeleteDraft({ repo: id, number: 1, id: 'x' }, ctx)).rejects.toMatchObject({ message: 'GitLab has no such draft' });
    await expect(w.forgeEditDraft({ repo: id, number: 1, id: '7', body: 'b' }, ctx)).rejects.toMatchObject({ kind: 'NotFound' });
  });
});
