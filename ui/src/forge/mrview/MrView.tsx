import { ExternalLink } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { FlyoutFrame } from '../../ui/flyout/FlyoutFrame';
import type { FlyoutProps } from '../../ui/flyout/flyout';
import { HoverTooltip } from '../../ui/HoverTooltip';
// --- 5B T3 ---
import { placeKey } from '../../nav/history';
import { useScrollPlace } from '../../nav/scroll';
// --- end 5B T3 ---
import { ForgeStaleNote } from '../ForgeStale';
import { EmojiText } from '../emoji';
import { mrName, mrRef } from '../labels';
import { MrStateIcon } from '../MrIcons';
import { knownMr, patchForge, useTabForge, type MrViewArgs } from '../mrStore';
import { refreshMr } from '../poll';
import { MrHeader, openInBrowser } from './MrHeader';
import { CheckoutButton } from './CheckoutButton';
import { MergeBox } from './MergeBox';
import { Thread } from './Thread';
// --- 4B T13 ---
import { MrActions } from './MrActions';
import { ReplyBox } from './ReplyBox';
import { StackPanel } from '../stack/StackPanel';
// --- end 4B T13 ---
import './mrview.css';

/**
 * The MR/PR view (spec #4 §4 "4B"), in the tab's left flyout: header, description, discussion;
 * 4B T13 adds reply, approve / request changes, edit and draft ⇄ ready, 4B T14 merge and check
 * out. It shows what's loaded (the list's or a badge's MR) at once, loads the rest, and keeps it
 * fresh through the poller (`openMr`).
 */
const REFRESH_GRACE_MS = 120;

export function MrView({ tabId, props, close }: FlyoutProps<MrViewArgs>) {
  const { number } = props;
  const f = useTabForge(tabId);
  const kind = f.kind ?? 'gitlab';
  useEffect(() => {
    patchForge(tabId, { openMr: number });
    // A beat of grace: arrowing down the sidebar's list opens each row in turn; only the one it rests on loads.
    const t = setTimeout(() => { void refreshMr(tabId, number).catch(() => {}); }, REFRESH_GRACE_MS);
    return () => { clearTimeout(t); patchForge(tabId, (cur) => (cur.openMr === number ? { openMr: null } : {})); };
  }, [tabId, number]);
  const detail = f.details[number]?.value ?? null;
  const mr = detail?.mr ?? knownMr(f, number);
  const ref = mrRef(kind, number);
  const label = `${mrName(kind)} ${ref}`;
  const error = f.detailErrors[number];
  // --- 5B T3: Back/Forward come back to where this view was scrolled (spec #5 §3.4) ---
  const probe = useRef<HTMLSpanElement>(null);
  useScrollPlace({
    tabId,
    kind: 'mr',
    key: placeKey({ kind: 'mr', number, scrollTop: 0 }),
    el: () => probe.current?.closest<HTMLElement>('.flyout-body') ?? null,
    active: true,
    ready: !!detail && f.discussions[number] !== undefined,
    view: null,
  });
  // --- end 5B T3 ---
  return (
    <FlyoutFrame
      label={label}
      onClose={close}
      title={<>{mr && <MrStateIcon state={mr.state} size={14} />}<span>{ref} <EmojiText text={mr?.title ?? ''} /></span></>}
      headerActions={mr && (
        <HoverTooltip content="Open in browser">
          <button type="button" className="icon-button" aria-label="Open in browser" onClick={() => openInBrowser(mr.webUrl)}><ExternalLink size={14} aria-hidden /></button>
        </HoverTooltip>
      )}
    >
      <span ref={probe} hidden />
      <ForgeStaleNote tabId={tabId} />
      {!mr && <p className="mr-wait">{error ? `Couldn't load ${label}: ${error}` : 'Loading…'}</p>}
      {/* The MR/PR's own refresh failed: what's shown is older. */}
      {mr && error && <p className="forge-stale-note" role="status">{`Couldn't refresh ${ref}: ${error}`}</p>}
      {mr && <MrHeader kind={kind} mr={mr} detail={detail} />}
      {/* --- 4D: the stack --- */}
      {mr && <StackPanel tabId={tabId} mr={mr} />}
      {/* --- end 4D --- */}
      {/* --- 4B T13: actions --- */}
      {mr && <MrActions tabId={tabId} kind={kind} mr={mr} detail={detail}><CheckoutButton tabId={tabId} mr={mr} /></MrActions>}
      {/* --- end 4B T13 --- */}
      {/* --- 4B T14: merge and check out --- */}
      {mr && <MergeBox key={mr.number} tabId={tabId} kind={kind} mr={mr} detail={detail} />}
      {/* --- end 4B T14 --- */}
      {mr && (
        <section className="mr-description" aria-label="Description">
          {detail ? (detail.description.trim() ? detail.description : <span className="mr-dim">No description</span>) : <span className="mr-dim">Loading…</span>}
        </section>
      )}
      {mr && <Thread tabId={tabId} kind={kind} mr={mr} discussions={f.discussions[number] ?? null} reviews={detail?.mr.review.reviews} />}
      {/* --- 4B T13: new comment --- */}
      {mr && <div className="mr-new-comment"><ReplyBox tabId={tabId} number={number} discussion={null} /></div>}
      {/* --- end 4B T13 --- */}
    </FlyoutFrame>
  );
}
