import { ExternalLink } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import type { ForgeKind } from '../../api/gen/ForgeKind';
import type { ForgeMr } from '../../api/gen/ForgeMr';
import type { ForgeMrDetail } from '../../api/gen/ForgeMrDetail';
import { FlyoutFrame } from '../../ui/flyout/FlyoutFrame';
import type { FlyoutProps } from '../../ui/flyout/flyout';
import { HoverTooltip } from '../../ui/HoverTooltip';
// --- 5B T3 ---
import { placeKey } from '../../nav/history';
import { useScrollPlace } from '../../nav/scroll';
// --- end 5B T3 ---
// --- 5A T10 ---
import { signedAttachments } from '../../markdown/attachments';
import { Markdown } from '../../markdown/lazy';
import { MR_BODY_MAX_BYTES } from '../../markdown/limits';
// --- end 5A T10 ---
import { ForgeStaleNote } from '../ForgeStale';
import { EmojiText } from '../emoji';
import { mrName, mrRef } from '../labels';
import { MrStateIcon } from '../MrIcons';
import { knownMr, patchForge, useTabForgeField, type MrViewArgs } from '../mrStore';
import { refreshMr } from '../poll';
import { MrHeader, openInBrowser } from './MrHeader';
import { CheckoutButton } from './CheckoutButton';
import { MergeBox } from './MergeBox';
import { Thread } from './Thread';
// --- 4B T13 ---
import { MrForms, ReviewButtons, StatusActions, useMrActions } from './MrActions';
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

/** The header with the actions in it (Check out, Edit and ⋯ on the status line; Approve and
 * Request changes in the APPROVALS box), the stack (4D), then the Request changes or Edit form. */
function MrTop({ tabId, kind, mr, detail }: { tabId: string; kind: ForgeKind; mr: ForgeMr; detail: ForgeMrDetail | null }) {
  const actions = useMrActions(tabId, kind, mr, detail);
  return (
    <>
      <MrHeader
        tabId={tabId}
        kind={kind}
        mr={mr}
        detail={detail}
        actions={<StatusActions actions={actions}><CheckoutButton tabId={tabId} mr={mr} /></StatusActions>}
        review={<ReviewButtons kind={kind} mr={mr} actions={actions} />}
      />
      {/* --- 4D: the stack --- */}
      <StackPanel tabId={tabId} mr={mr} />
      {/* --- end 4D --- */}
      {/* --- 4B T13: the actions' forms --- */}
      <MrForms tabId={tabId} kind={kind} mr={mr} detail={detail} actions={actions} />
      {/* --- end 4B T13 --- */}
    </>
  );
}

export function MrView({ tabId, props, close }: FlyoutProps<MrViewArgs>) {
  const { number } = props;
  // The fields it shows, not the whole forge state: a poll tick (`updatedAt`) re-renders nothing.
  const kind = useTabForgeField(tabId, 'kind') ?? 'gitlab';
  const details = useTabForgeField(tabId, 'details');
  const detailErrors = useTabForgeField(tabId, 'detailErrors');
  const discussions = useTabForgeField(tabId, 'discussions');
  const list = useTabForgeField(tabId, 'list');
  const byRef = useTabForgeField(tabId, 'byRef');
  useEffect(() => {
    patchForge(tabId, { openMr: number });
    // A beat of grace: arrowing down the sidebar's list opens each row in turn; only the one it rests on loads.
    const t = setTimeout(() => { void refreshMr(tabId, number).catch(() => {}); }, REFRESH_GRACE_MS);
    return () => { clearTimeout(t); patchForge(tabId, (cur) => (cur.openMr === number ? { openMr: null } : {})); };
  }, [tabId, number]);
  const detail = details[number]?.value ?? null;
  const mr = detail?.mr ?? knownMr({ details, list, byRef }, number);
  const ref = mrRef(kind, number);
  const label = `${mrName(kind)} ${ref}`;
  const error = detailErrors[number];
  // --- 5A final review: the description's text and context keep their identity across renders ---
  const description = useMemo(() => (detail ? signedAttachments(detail.description, detail.bodyHtml ?? null) : ''), [detail]);
  const context = useMemo(() => ({ kind: 'forge', tabId }) as const, [tabId]);
  // --- 5B T3: Back/Forward come back to where this view was scrolled (spec #5 §3.4) ---
  const probe = useRef<HTMLSpanElement>(null);
  useScrollPlace({
    tabId,
    kind: 'mr',
    key: placeKey({ kind: 'mr', number, scrollTop: 0 }),
    el: () => probe.current?.closest<HTMLElement>('.flyout-body') ?? null,
    active: true,
    ready: !!detail && discussions[number] !== undefined,
    view: null,
  });
  // --- end 5B T3 ---
  return (
    <FlyoutFrame
      label={label}
      onClose={close}
      wrapTitle
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
      {/* The header, the stack and the actions' forms. */}
      {mr && <MrTop tabId={tabId} kind={kind} mr={mr} detail={detail} />}
      {/* --- 4B T14: merge and check out --- */}
      {mr && <MergeBox key={mr.number} tabId={tabId} kind={kind} mr={mr} detail={detail} />}
      {/* --- end 4B T14 --- */}
      {mr && (
        <section className="mr-description" aria-label="Description">
          {/* --- 5A T10: rendered Markdown (spec #5 §1), plain over 1 MB --- */}
          {detail
            ? (detail.description.trim()
              ? <Markdown text={description} flavor={kind} context={context} maxBytes={MR_BODY_MAX_BYTES} />
              : <span className="mr-dim">No description</span>)
            : <span className="mr-dim">Loading…</span>}
          {/* --- end 5A T10 --- */}
        </section>
      )}
      {mr && <Thread tabId={tabId} kind={kind} mr={mr} discussions={discussions[number] ?? null} reviews={detail?.mr.review.reviews} />}
      {/* --- 4B T13: new comment --- */}
      {mr && <div className="mr-new-comment"><ReplyBox tabId={tabId} number={number} discussion={null} /></div>}
      {/* --- end 4B T13 --- */}
    </FlyoutFrame>
  );
}
