import type { ForgeKind } from '../api/gen/ForgeKind';
import type { ForgeMr } from '../api/gen/ForgeMr';
import { MrCard } from './MrCard';
import { useMrDetail } from './useMrDetail';

/** The hover card, with the MR/PR's detail loaded while it shows. */
export function MrCardLive({ tabId, kind, mr, hint }: { tabId: string; kind: ForgeKind; mr: ForgeMr; hint?: string }) {
  const { detail, error } = useMrDetail(tabId, mr.number);
  return <MrCard kind={kind} mr={mr} detail={detail} error={error} hint={hint} />;
}
