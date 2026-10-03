import { useEffect, useRef, type RefObject } from 'react';
import { disarm, useArm } from './store';

/** Disarms a control armed inside `ref` once `key` changes: what its label counted (5 files, 2
 * resolved files) isn't what a second click would act on any more. */
export function useDisarmOnChange(ref: RefObject<HTMLElement | null>, key: unknown): void {
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const el = useArm.getState().armed?.origin?.el;
    if (el && ref.current?.contains(el)) disarm();
  }, [ref, key]);
}
