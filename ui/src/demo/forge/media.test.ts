import { describe, expect, it } from 'vitest';
import { forgeReadHandlers as h } from '../handlers/forgeReads';
import { labCtx, UPLOAD_SECRET } from './testkit';

const UPLOAD = `https://gitlab.example.com/orbital/forge-lab/uploads/${UPLOAD_SECRET}/shot.png`;
const CLIP = `https://gitlab.example.com/orbital/forge-lab/uploads/${UPLOAD_SECRET}/clip.webm`;

describe('forge media', () => {
  it('an upload of the project comes from the bundle; another host asks; "load anyway" is not in the demo', async () => {
    const { ctx, id } = await labCtx({ upload: true });
    expect(await h.forgeImage({ repo: id, url: UPLOAD, userAllowed: false }, ctx)).toMatchObject({ kind: 'found', mime: 'image/png' });
    expect(await h.forgeImage({ repo: id, url: 'https://images.example.com/a.png', userAllowed: false }, ctx)).toEqual({ kind: 'ask', host: 'images.example.com' });
    expect(await h.forgeImage({ repo: id, url: 'https://images.example.com/a.png', userAllowed: true }, ctx)).toEqual({ kind: 'missing', reason: 'Not in the demo: loading images.example.com' });
    // The core's reason for a 404 is the status.
    expect(await h.forgeImage({ repo: id, url: `${UPLOAD.slice(0, -4)}x.png`, userAllowed: false }, ctx)).toEqual({ kind: 'missing', reason: '404' });
  });

  it('another project\'s upload asks, and a video is not an image', async () => {
    const { ctx, id } = await labCtx({ upload: true });
    expect(await h.forgeImage({ repo: id, url: UPLOAD.replace('forge-lab', 'other'), userAllowed: false }, ctx)).toEqual({ kind: 'ask', host: 'gitlab.example.com' });
    expect(await h.forgeVideo({ repo: id, url: CLIP, userAllowed: false }, ctx)).toMatchObject({ kind: 'found', mime: 'video/webm' });
    expect(await h.forgeImage({ repo: id, url: CLIP, userAllowed: false }, ctx)).toMatchObject({ kind: 'missing', reason: expect.stringContaining('not an image') });
    expect(await h.forgeVideo({ repo: id, url: UPLOAD, userAllowed: false }, ctx)).toMatchObject({ kind: 'missing', reason: expect.stringContaining('not a video') });
  });
});
