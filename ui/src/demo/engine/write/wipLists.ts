// A write's fresh WIP lists (`WipListsPayload`): both of the worktree's lists as `fileList` answers
// them, stamped with one version (on the payload and on each list, as the core's snapshot.rs does).
// The core's version is Rust's DefaultHasher over the lists; this one a 64-bit FNV-1a: the same
// contract (same lists, same version), other digits.
import type { WipListsPayload } from '../../../api/gen/WipListsPayload';
import { totals, wipStaged, wipUnstaged } from '../read/changes';
import type { WriteWt } from './seam';

export function digest(text: string): string {
  let h = 0xcbf29ce484222325n;
  for (const b of new TextEncoder().encode(text)) h = ((h ^ BigInt(b)) * 0x100000001b3n) & 0xffffffffffffffffn;
  return h.toString(16).padStart(16, '0');
}

export async function wipLists(wt: WriteWt): Promise<WipListsPayload> {
  const staged = totals(await wipStaged(wt.repo, wt.root));
  const unstaged = totals(await wipUnstaged(wt.repo, wt.root));
  const version = digest(`${JSON.stringify(staged)}\0${JSON.stringify(unstaged)}`);
  return { worktree: wt.root, version, staged: { ...staged, version }, unstaged: { ...unstaged, version } };
}
