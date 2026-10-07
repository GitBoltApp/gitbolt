/** Views stepping the changes now (`useChangeKeys` on): the Next / Previous change actions
 * (`diff/keyActions.ts`) are usable meanwhile. Its own module, so the startup chunk's actions
 * don't pull in the diff toolbar. */
let stepping = 0;
export const changeKeysOn = (): boolean => stepping > 0;

/** One more view stepping the changes; returns its end. */
export function startStepping(): () => void {
  stepping++;
  return () => { stepping--; };
}
