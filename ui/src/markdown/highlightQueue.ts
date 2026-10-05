import type { CodeTokens } from '../diff/monaco/shiki';
import { whenIdle } from './idle';

/** The longest a slice of tokenizing may run before it yields (ruling 21). */
export const SLICE_MS = 25;

interface Job { code: string; lang: string; cancelled: boolean; resolve(t: CodeTokens | null): void }
const queue: Job[] = [];
let scheduled = false;

function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  whenIdle(() => { scheduled = false; void slice(); });
}

/** One idle slice: loads grammars as needed (async, outside the budget), then tokenizes blocks
 * until `SLICE_MS` has passed, and schedules the next slice for the rest. A block that alone takes
 * longer still finishes (blocks over `HIGHLIGHT_MAX_CHARS` never get here). */
async function slice(): Promise<void> {
  const shiki = await import('../diff/monaco/shiki');
  let start = performance.now();
  while (queue.length > 0) {
    const job = queue[0];
    if (job.cancelled) { queue.shift(); continue; }
    const before = performance.now();
    const id = await shiki.ensureGrammar(job.lang);
    // A grammar that had to load ended the task: the budget starts again.
    if (performance.now() - before > 1) start = performance.now();
    queue.shift();
    if (job.cancelled) continue;
    job.resolve(id ? shiki.tokensFor(job.code, id) : null);
    if (performance.now() - start >= SLICE_MS) break;
  }
  if (queue.length > 0) schedule();
}

/** A code block's tokens, from the shared queue (Shiki's chunk loads on the first). */
export function queueHighlight(code: string, lang: string): { result: Promise<CodeTokens | null>; cancel(): void } {
  let job!: Job;
  const result = new Promise<CodeTokens | null>((resolve) => { job = { code, lang, cancelled: false, resolve }; });
  queue.push(job);
  schedule();
  return { result, cancel: () => { job.cancelled = true; } };
}
