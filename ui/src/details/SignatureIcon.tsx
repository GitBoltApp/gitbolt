import type { ReactNode } from 'react';
import type { SignatureKind } from '../api/gen/SignatureKind';

/** A signature status, plus the badge's own states: checking, and a failed check. */
export type SignatureIconKind = SignatureKind | 'loading' | 'error';

// Our own drawings (feedback F16): a shield on a 16×16 grid
// with one mark per status. Stroked in `currentColor`; the badge's CSS colours it.
const SHIELD = 'M8 1.6 13.4 3.6V7.7c0 3.1-2.2 5.7-5.4 6.8C4.8 13.4 2.6 10.8 2.6 7.7V3.6Z';
const MARK: Record<SignatureIconKind, ReactNode> = {
  verified: <path d="M5.5 8.1l1.7 1.8 3.3-3.5" />,
  unverified: <><path d="M8 5v3.3" /><path d="M8 10.7v.1" /></>,
  bad: <path d="M6 6l4 4M10 6l-4 4" />,
  expired: <><circle cx="8" cy="8" r="2.9" /><path d="M8 6.6V8l1 .8" /></>,
  unknownKey: <><path d="M6.5 6.4a1.6 1.6 0 1 1 2.2 1.5c-.5.2-.7.5-.7 1v.2" /><path d="M8 10.8v.1" /></>,
  unsigned: null,
  loading: null,
  error: <path d="M5.6 10.4l4.8-4.8" />,
};

/** The shield is filled faintly for a real status; unsigned and checking are a bare outline. */
const BARE = new Set<SignatureIconKind>(['unsigned', 'loading']);

export function SignatureIcon({ kind, size = 16 }: { kind: SignatureIconKind; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" data-icon={kind}>
      <path d={SHIELD} fill={BARE.has(kind) ? 'none' : 'currentColor'} fillOpacity={0.18} strokeDasharray={kind === 'loading' ? '2 1.6' : undefined} />
      {MARK[kind]}
    </svg>
  );
}
