// A push's `remote:` lines, as the core classifies them (write/remote_output.rs `parse`, `classify`,
// `summarize`): forge links, blank lines and pack meters are boilerplate, failure words make a
// warning, the rest is information. The demo's lines come from its network's `serverLines` hooks
// (the fake forge's GitLab links), already without git's `remote: ` prefix.
import type { RemoteLine } from '../../../api/gen/RemoteLine';
import type { RemoteSummary } from '../../../api/gen/RemoteSummary';
import { redact } from '../remotes';

/** §12.4's failure words, matched case-insensitively anywhere in the line. */
const WARNINGS = ['error', 'fatal', 'fail', 'reject', 'denied', 'conflict', 'could not', 'cannot', 'abort', 'warning'];
/** Forge lines followed by their URL line. */
const LINK_INTROS = ['To create a merge request for ', 'View merge request for ', 'Create a pull request for '];
/** git's own pack messages from the remote side. */
const METERS = ['Enumerating objects:', 'Counting objects:', 'Compressing objects:', 'Finding sources:', 'Resolving deltas:', 'Writing objects:', 'Total '];

/** The core's netops.rs `parse_progress`, as a test: `Phase: NN%…`, or `Fetching …`. */
function isProgress(t: string): boolean {
  const colon = t.indexOf(':');
  if (colon > 0) {
    const phase = t.slice(0, colon);
    const rest = t.slice(colon + 1).trimStart();
    const digits = /^[0-9]+/.exec(rest)?.[0] ?? '';
    if (/^[A-Za-z ]+$/.test(phase) && digits !== '' && rest.slice(digits.length).startsWith('%')) return true;
  }
  return t.startsWith('Fetching ');
}

function kindOf(text: string, afterIntro: boolean): RemoteLine['kind'] {
  const t = text.trim();
  if (t === '' || METERS.some((m) => t.startsWith(m)) || isProgress(t) || LINK_INTROS.some((p) => t.startsWith(p))) return 'boilerplate';
  if (afterIntro && (t.startsWith('https://') || t.startsWith('http://'))) return 'boilerplate';
  const lower = t.toLowerCase();
  return WARNINGS.some((w) => lower.includes(w)) ? 'warning' : 'info';
}

/** The server's lines, in order: each redacted and trimmed at the end, then classified. */
export function classify(lines: string[]): RemoteLine[] {
  let afterIntro = false;
  return lines.map((raw) => {
    const text = redact(raw).trimEnd();
    const kind = kindOf(text, afterIntro);
    afterIntro = LINK_INTROS.some((p) => text.trimStart().startsWith(p));
    return { text, kind };
  });
}

/** The toast's count (info and warning lines) and the first warning, which it quotes. */
export function summarize(lines: RemoteLine[]): RemoteSummary {
  return { lines: lines.filter((l) => l.kind !== 'boilerplate').length, warning: lines.find((l) => l.kind === 'warning')?.text.trim() ?? null };
}
