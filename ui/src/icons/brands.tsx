import { Cloud } from 'lucide-react';
import type { HostKind } from '../api/gen/HostKind';
import { useAppState } from '../app/state';
import { effectiveKind } from '../forge/urls';

// SVG paths from simple-icons 16.32.0 (CC0 1.0): https://simpleicons.org. Copied rather than
// depending on the whole icon set; only colors come from nowhere else (spec §12.1: no third-party app art).
const GITLAB = 'm23.6004 9.5927-.0337-.0862L20.3.9814a.851.851 0 0 0-.3362-.405.8748.8748 0 0 0-.9997.0539.8748.8748 0 0 0-.29.4399l-2.2055 6.748H7.5375l-2.2057-6.748a.8573.8573 0 0 0-.29-.4412.8748.8748 0 0 0-.9997-.0537.8585.8585 0 0 0-.3362.4049L.4332 9.5015l-.0325.0862a6.0657 6.0657 0 0 0 2.0119 7.0105l.0113.0087.03.0213 4.976 3.7264 2.462 1.8633 1.4995 1.1321a1.0085 1.0085 0 0 0 1.2197 0l1.4995-1.1321 2.4619-1.8633 5.006-3.7489.0125-.01a6.0682 6.0682 0 0 0 2.0094-7.003z';
const GITHUB = 'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12';

function Mark({ path, label, size, kind }: { path: string; label: string; size: number; kind: HostKind }) {
  return (
    <svg role="img" aria-label={label} data-host-kind={kind} width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d={path} />
    </svg>
  );
}

export const GitLabMark = ({ size = 12, label = 'GitLab' }: { size?: number; label?: string }) => <Mark path={GITLAB} label={label} size={size} kind="gitlab" />;
export const GitHubMark = ({ size = 12, label = 'GitHub' }: { size?: number; label?: string }) => <Mark path={GITHUB} label={label} size={size} kind="github" />;

/** Remote icon by host type (spec §8.5, §14.4): GitLab fox, GitHub mark, else a generic cloud. */
export function RemoteIcon({ kind: detected, host, remote, size = 12 }: { kind: HostKind; host?: string | null; remote: string; size?: number }) {
  // The profile's host-type override for this remote's host (Settings > Hosts), else the detected one.
  const kind = useAppState((s) => effectiveKind(host, detected, s.profile.hostOverrides));
  const label = `remote ${remote}`;
  if (kind === 'gitlab') return <GitLabMark size={size} label={label} />;
  if (kind === 'github') return <GitHubMark size={size} label={label} />;
  // An outline icon: one step up, to read the same size as the filled brand marks (RefLabels'
  // SOURCE_OUTLINE).
  return <Cloud size={size + 2} aria-label={label} data-host-kind="generic" />;
}
