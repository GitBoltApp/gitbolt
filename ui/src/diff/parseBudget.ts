import { useEffect, useState } from 'react';
import type { ChunkStream } from '../markdown/parseAsync';
import { markSlow, PARSE_BUDGET_MS } from './markdownFiles';

/**
 * Spec #5 §3.1, shared by File View and (5C, R14) Diff View: a long document's parse, or diff, is
 * timed once off the main thread before it renders. `open` loads the stream module and answers
 * the stream's maker, so the clock starts as the stream is posted. The renderer asks for the same
 * stream later, so nothing runs twice. One not done within PARSE_BUDGET_MS goes on the slow list
 * at the budget (a timer races the stream), as does one too large for the main thread (the worker
 * died, or the alignment gave up). A result that arrives after `key` changed is dropped. True
 * while it's being timed.
 */
export function useParseBudget(key: string, needsCheck: boolean, open: () => Promise<() => ChunkStream>): boolean {
  const [checked, setChecked] = useState<string | null>(null);
  useEffect(() => {
    if (!needsCheck || checked === key) return;
    let live = true;
    let unsub = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    void open().then((make) => {
      if (!live) return;
      const t0 = performance.now();
      const stream = make();
      const finish = (late: boolean) => {
        unsub(); // a stream left with no subscriber mid-parse is abandoned: its worker stops (parseAsync)
        clearTimeout(timer);
        if (!live) return;
        if (late || stream.tooLarge || (!stream.failed && performance.now() - t0 > PARSE_BUDGET_MS)) markSlow(key);
        setChecked(key);
      };
      if (stream.done) finish(false);
      else {
        unsub = stream.subscribe(() => { if (stream.done) finish(false); });
        // Still running at the budget: Source now, not when it ends.
        timer = setTimeout(() => finish(true), PARSE_BUDGET_MS);
      }
    });
    return () => { live = false; unsub(); clearTimeout(timer); };
  }, [needsCheck, checked, key]); // eslint-disable-line react-hooks/exhaustive-deps
  return needsCheck && checked !== key;
}
