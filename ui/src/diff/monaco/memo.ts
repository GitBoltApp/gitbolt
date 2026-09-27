/** Runs `load` once and shares its promise, unless it rejects: a failed load is forgotten, so
 * the next call tries again instead of replaying the failure forever. */
export function memoizeUntilRejected<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () =>
    (pending ??= load().catch((e: unknown) => {
      pending = undefined;
      throw e;
    }));
}
