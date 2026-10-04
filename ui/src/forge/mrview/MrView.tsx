import { ExternalLink } from 'lucide-react';
import { useEffect } from 'react';
import { FlyoutFrame } from '../../ui/flyout/FlyoutFrame';
import type { FlyoutProps } from '../../ui/flyout/flyout';
import { HoverTooltip } from '../../ui/HoverTooltip';
import { ForgeStaleNote } from '../ForgeStale';
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
// --- end 4B T13 ---
import './mrview.css';

/**
 * The MR/PR view (spec #4 §4 "4B"), in the tab's left flyout: header, description, discussion;
 * 4B T13 adds reply, approve / request changes, edit and draft ⇄ ready, 4B T14 merge and check
 * out. It shows what's loaded (the list's or a badge's MR) at once, loads the rest, and keeps it
 * fresh through the poller (`openMr`).
 */
export function MrView({ tabId, props, close }: FlyoutProps<MrViewArgs>) {
  const { number } = props;
  const f = useTabForge(tabId);
  const kind = f.kind ?? 'gitlab';
  useEffect(() => {
    patchForge(tabId, { openMr: number });
    void refreshMr(tabId, number).catch(() => {});
    return () => patchForge(tabId, (cur) => (cur.openMr === number ? { openMr: null } : {}));
  }, [tabId, number]);
  const detail = f.details[number]?.value ?? null;
  const mr = detail?.mr ?? knownMr(f, number);
  const ref = mrRef(kind, number);
  const label = `${mrName(kind)} ${ref}`;
  const error = f.detailErrors[number];
  return (
    <FlyoutFrame
      label={label}
      onClose={close}
      title={<>{mr && <MrStateIcon state={mr.state} size={14} />}<span>{ref} {mr?.title ?? ''}</span></>}
      headerActions={mr && (
        <HoverTooltip content="Open in browser">
          <button type="button" className="icon-button" aria-label="Open in browser" onClick={() => openInBrowser(mr.webUrl)}><ExternalLink size={14} aria-hidden /></button>
        </HoverTooltip>
      )}
    >
      <ForgeStaleNote tabId={tabId} />
      {!mr && <p className="mr-wait">{error ? `Couldn't load ${label}: ${error}` : 'Loading…'}</p>}
      {/* The MR/PR's own refresh failed: what's shown is older. */}
      {mr && error && <p className="forge-stale-note" role="status">{`Couldn't refresh ${ref}: ${error}`}</p>}
      {mr && <MrHeader kind={kind} mr={mr} detail={detail} />}
      {/* --- 4D: the stack --- */}
      {/* --- end 4D --- */}
      {/* --- 4B T13: actions --- */}
      {mr && <MrActions tabId={tabId} kind={kind} mr={mr} detail={detail} />}
      {/* --- end 4B T13 --- */}
      {/* --- 4B T14: merge and check out --- */}
      {mr && <div className="mr-actions"><CheckoutButton tabId={tabId} mr={mr} /></div>}
      {mr && <MergeBox key={mr.number} tabId={tabId} kind={kind} mr={mr} detail={detail} />}
      {/* --- end 4B T14 --- */}
      {mr && (
        <section className="mr-description" aria-label="Description">
          {detail ? (detail.description.trim() ? detail.description : <span className="mr-dim">No description</span>) : <span className="mr-dim">Loading…</span>}
        </section>
      )}
      {mr && <Thread tabId={tabId} kind={kind} mr={mr} discussions={f.discussions[number] ?? null} />}
      {/* --- 4B T13: new comment --- */}
      {mr && <ReplyBox tabId={tabId} number={number} discussion={null} />}
      {/* --- end 4B T13 --- */}
    </FlyoutFrame>
  );
}
