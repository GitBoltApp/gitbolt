import { mrRef } from '../forge/labels';
import { forgeOf, knownMr, MR_FLYOUT, type MrViewArgs } from '../forge/mrStore';
import { loadMrDetail, openMrView } from '../forge/poll';
import { closeFlyout, flyoutOf } from '../ui/flyout/flyout';
import { useToast } from '../ui/toast';
import { placeKey, registerPlaceKind } from './history';
import { scrollOf, setPendingScroll } from './scroll';

const showsMr = (tabId: string, number: number) => {
  const f = flyoutOf(tabId);
  return f?.kind === MR_FLYOUT && (f.props as MrViewArgs).number === number;
};

/**
 * Spec #5 §3.4: an MR/PR view as a navigation place. Restoring reopens the view, scrolled where
 * it was left. One that's gone (no forge target any more, or nothing known about it after a
 * fresh load) says "Couldn't load !12", closes, and is skipped.
 */
const off = registerPlaceKind('mr', {
  capture: (tabId, p) => {
    const top = scrollOf(tabId, 'mr', placeKey(p));
    return top === null ? null : { ...p, scrollTop: top };
  },
  async restore(tabId, p) {
    const kind = forgeOf(tabId).kind;
    const failed = () => {
      useToast.getState().show(`Couldn't load ${mrRef(kind ?? 'gitlab', p.number)}`);
      return false;
    };
    if (kind === null) return failed();
    setPendingScroll(tabId, 'mr', { key: placeKey(p), view: null, top: p.scrollTop, anchor: null });
    openMrView(tabId, p.number);
    await loadMrDetail(tabId, p.number, 0);
    const f = forgeOf(tabId);
    if (f.details[p.number] || knownMr(f, p.number)) return true;
    if (showsMr(tabId, p.number)) closeFlyout(tabId);
    return failed();
  },
});

import.meta.hot?.dispose(off);
