/** Runs `fn` when the main thread is idle, after the first paint, or after `timeout` ms at the
 * latest; returns its cancel. jsdom has no requestIdleCallback: a timer stands in. */
export function whenIdle(fn: () => void, timeout = 300): () => void {
  if (typeof requestIdleCallback === 'function') {
    const id = requestIdleCallback(fn, { timeout });
    return () => cancelIdleCallback(id);
  }
  const id = setTimeout(fn, 1);
  return () => clearTimeout(id);
}
