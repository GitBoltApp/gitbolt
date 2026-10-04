import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { ForgeMr } from '../../api/gen/ForgeMr';
import { useRuntime } from '../../app/runtime';
import { HoverTooltip } from '../../ui/HoverTooltip';
import { checkoutMr, checkoutState } from './checkout';

/** Check out (spec #4 §4 "4B"), following the tab's branches and remotes as they change. */
export function CheckoutButton({ tabId, mr }: { tabId: string; mr: ForgeMr }) {
  const { label, disabled } = useRuntime(useShallow(() => checkoutState(tabId, mr)));
  const [busy, setBusy] = useState(false);
  return (
    <HoverTooltip content={disabled ?? `Check out ${mr.sourceBranch}`}>
      <button
        type="button"
        className="mr-button"
        disabled={disabled !== null || busy}
        onClick={async () => {
          setBusy(true);
          await checkoutMr(tabId, mr);
          setBusy(false);
        }}
      >
        {busy ? 'Checking out…' : label}
      </button>
    </HoverTooltip>
  );
}
