import type { Root } from 'mdast';
import { splitChunks } from '../chunks';
import type { MdFlavor } from '../types';
import { diffMarkdown } from './diffTree';

/** The rendered diff of `old` → `neu`, cut into chunks for Task 12's progressive rendering; the
 * first chunk carries the number of changes (`gbChanges`). `null`: the alignment gave up (R14). */
export function diffChunks(old: string, neu: string, flavor: MdFlavor): Root[] | null {
  const r = diffMarkdown(old, neu, flavor);
  if (r.gaveUp) return null;
  const chunks = splitChunks(r.root);
  chunks[0]!.data = { ...chunks[0]!.data, gbChanges: r.changes };
  return chunks;
}
