// A binary's hex dumps load with its contents (the services' `contents` loader), so a binary is
// ready to show in the same render as a text file is: the panel's editor stays mounted and keeps
// the previous file until the dumps' diff is on screen (F24, K7). No React or Monaco here: the
// services module is in the startup chunk.
import { api, type ContentsRequest } from '../api/client';
import type { DiffContentsPayload } from '../api/gen/DiffContentsPayload';
import type { HexDumpPayload } from '../api/gen/HexDumpPayload';

/** Contents, with a binary's hex dumps (`hexDump`) when it has them. */
export type HexContents = DiffContentsPayload & { hex?: HexDumpPayload };

/** A binary loaded for the viewer that isn't a raster image: it shows as hex. (An SVG with a
 * binary side has no image bytes, so it's one too.) */
export const wantsHex = (c: DiffContentsPayload) => !c.tooLarge && !c.image && !!(c.old?.binary || c.new?.binary);

export const hexOf = (c: DiffContentsPayload): HexDumpPayload | null => (c as HexContents).hex ?? null;

/** `diffContents`, then, for a binary, `hexDump` of the same sides. */
export async function loadContents(repo: number, req: ContentsRequest): Promise<HexContents> {
  const c = await api.diffContents(repo, req);
  return wantsHex(c) ? { ...c, hex: await api.hexDump(repo, req) } : c;
}

/** The dumps' share of the cache's size (UTF-16). */
export const hexSize = (c: DiffContentsPayload) => {
  const h = hexOf(c);
  return h ? ((h.old?.dump.length ?? 0) + (h.new?.dump.length ?? 0)) * 2 : 0;
};
