export interface Debounced<A extends unknown[]> {
  (...args: A): void;
  /** Runs a pending call now and waits for it. */
  flush(): Promise<void>;
  cancel(): void;
}

/** Trailing-edge debounce that keeps only the latest arguments. */
export function debounce<A extends unknown[]>(fn: (...args: A) => unknown, ms: number): Debounced<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: A | undefined;
  const run = async () => {
    clearTimeout(timer);
    timer = undefined;
    const args = pending;
    pending = undefined;
    if (args) await fn(...args);
  };
  const d = ((...args: A) => {
    pending = args;
    clearTimeout(timer);
    timer = setTimeout(() => { run().catch((e) => console.warn('[gitbolt] debounced call failed', e)); }, ms);
  }) as Debounced<A>;
  d.flush = run;
  d.cancel = () => { clearTimeout(timer); timer = undefined; pending = undefined; };
  return d;
}
