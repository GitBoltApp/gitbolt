import { useEffect, useState, type FocusEvent, type MouseEvent, type ReactNode } from 'react';
import { errorMessage } from '../api/client';
import type { SignatureKind } from '../api/gen/SignatureKind';
import type { SignaturePayload } from '../api/gen/SignaturePayload';
import { useRepoView } from '../repo/store';
import { useHoverTooltip } from '../ui/HoverTooltip';
import { SignatureIcon, type SignatureIconKind } from './SignatureIcon';
import './header.css';

const LABEL: Record<SignatureKind, string> = { verified: 'Verified', unverified: 'Unverified', bad: 'Bad signature', expired: 'Expired', unknownKey: 'Unknown key', unsigned: 'Not signed' };

type Check = { status: 'ready'; value: SignaturePayload } | { status: 'error'; message: string };

function card(title: string, s: SignaturePayload | null): ReactNode {
  const lines = s ? [
    s.signer && `Signer: ${s.signer}`,
    s.key && `Key: ${s.key}`,
    s.fingerprint && s.fingerprint !== s.key && `Fingerprint: ${s.fingerprint}`,
    s.trust && `Trust: ${s.trust}`,
    s.detail,
  ].filter(Boolean) : [];
  return <div className="hovercard"><div className="hovercard-title">{title}</div>{lines.map((l, i) => <div key={i}>{l}</div>)}</div>;
}

/**
 * The signature status (spec §9.1), as just an icon with a different drawing per status
 * (feedback F16); "Not signed" is a dim bare shield. An unsigned commit says so without asking
 * git; a signed one is verified lazily when selected (cached per commit id by
 * `services.signature`). The status, signer, key, fingerprint, trust and detail show in a hover
 * card, portaled so the details panel can't clip it.
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

  let kind: SignatureIconKind, label: string, content: ReactNode;
  if (!signed) [kind, label] = ['unsigned', LABEL.unsigned];
  else if (!result) [kind, label] = ['loading', 'Checking signature…'];
  else if (result.status === 'error') [kind, label] = ['error', 'Signature check failed'];
  else [kind, label] = [result.value.kind, LABEL[result.value.kind]];
  if (result?.status === 'error') content = <div className="hovercard"><div className="hovercard-title">{label}</div><div>{result.message}</div></div>;
  else content = card(label, result?.status === 'ready' ? result.value : null);
  const { triggerProps, tooltip, hide } = useHoverTooltip({ content });
  // Focusable, and focus shows the same card (the hover tooltip only needs the trigger element).
  const onFocus = (e: FocusEvent<HTMLElement>) => triggerProps.onMouseEnter(e as unknown as MouseEvent<HTMLElement>);
  return (
    <span className={`sig-badge sig-${kind}`} role="img" aria-label={label} tabIndex={0} data-testid="signature-badge" data-kind={kind} {...triggerProps} onFocus={onFocus} onBlur={hide}>
      <SignatureIcon kind={kind} />
      {tooltip}
    </span>
  );
}
