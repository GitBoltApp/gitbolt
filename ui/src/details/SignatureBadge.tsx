import { BadgeCheck, BadgeX, KeyRound, ShieldAlert, ShieldOff, ShieldQuestionMark, TriangleAlert, type LucideIcon } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { errorMessage } from '../api/client';
import type { SignatureKind } from '../api/gen/SignatureKind';
import type { SignaturePayload } from '../api/gen/SignaturePayload';
import { useRepoView } from '../repo/store';
import { useHoverTooltip } from '../ui/HoverTooltip';
import './header.css';

const LABEL: Record<SignatureKind, string> = { verified: 'Verified', unverified: 'Unverified', bad: 'Bad signature', expired: 'Expired', unknownKey: 'Unknown key', unsigned: 'Not signed' };
const ICON: Record<SignatureKind, LucideIcon> = { verified: BadgeCheck, unverified: ShieldQuestionMark, bad: BadgeX, expired: ShieldAlert, unknownKey: KeyRound, unsigned: ShieldOff };

type Check = { status: 'ready'; value: SignaturePayload } | { status: 'error'; message: string };

function card(s: SignaturePayload): ReactNode {
  const lines = [
    s.signer && `Signer: ${s.signer}`,
    s.key && `Key: ${s.key}`,
    s.fingerprint && s.fingerprint !== s.key && `Fingerprint: ${s.fingerprint}`,
    s.trust && `Trust: ${s.trust}`,
    s.detail,
  ].filter(Boolean);
  return lines.length ? <div className="hovercard">{lines.map((l, i) => <div key={i}>{l}</div>)}</div> : null;
}

/**
 * The signature badge (spec §9.1). An unsigned commit says so without asking git; a signed one
 * is verified lazily when selected (cached per commit id by `services.signature`). The signer,
 * key, fingerprint, trust and detail show in a hover card, portaled so the scrolling details
 * panel can't clip it.
 */
export function SignatureBadge({ id, signed }: { id: string; signed: boolean }) {
  const services = useRepoView((s) => s.services);
  const [check, setCheck] = useState<{ id: string; result: Check } | null>(null);
  useEffect(() => {
    if (!signed) return;
    let live = true;
    services.signature.get(id).then(
      (value) => { if (live) setCheck({ id, result: { status: 'ready', value } }); },
      (e: unknown) => { if (live) setCheck({ id, result: { status: 'error', message: errorMessage(e) } }); },
    );
    return () => { live = false; };
  }, [id, signed, services]);

  const cached = signed ? services.signature.peek(id) : undefined;
  const result: Check | null = check?.id === id ? check.result : cached ? { status: 'ready', value: cached } : null;
  const content = result?.status === 'ready' ? card(result.value) : result?.status === 'error' ? <div className="hovercard">{result.message}</div> : null;
  const { triggerProps, tooltip } = useHoverTooltip({ content, disabled: !content });

  let kind: string, label: string, Icon: LucideIcon | null;
  if (!signed) [kind, label, Icon] = ['unsigned', LABEL.unsigned, ICON.unsigned];
  else if (!result) [kind, label, Icon] = ['loading', 'Checking signature…', null];
  else if (result.status === 'error') [kind, label, Icon] = ['error', 'Signature check failed', TriangleAlert];
  else [kind, label, Icon] = [result.value.kind, LABEL[result.value.kind], ICON[result.value.kind]];
  return (
    <span className={`sig-badge sig-${kind}`} data-testid="signature-badge" data-kind={kind} {...triggerProps}>
      {Icon && <Icon size={12} aria-hidden />}
      <span>{label}</span>
      {tooltip}
    </span>
  );
}
