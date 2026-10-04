/** Account changes reach the pollers through here, so the Settings section doesn't import the polling machinery. */
const listeners = new Set<() => void>();
export const onForgeAccountsChanged = (fn: () => void): (() => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};
export const notifyForgeAccountsChanged = (): void => { for (const fn of [...listeners]) fn(); };
