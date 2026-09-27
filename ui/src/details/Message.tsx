import { GitPullRequest } from 'lucide-react';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { api, errorMessage } from '../api/client';
import type { RepoServices } from '../repo/services';
import { useToast } from '../ui/toast';
import { mergeRequestButtons, projectRemote, tokenizeMessage, type MessageToken, type ProjectRemote } from './messageLinks';
import './header.css';

/** The remote that message references point at (spec §14.4): the first with a parsed host. */
export function useProjectRemote(services: RepoServices): ProjectRemote | null {
  const [remote, setRemote] = useState<ProjectRemote | null>(null);
  useEffect(() => {
    let live = true;
    services.remotes().then((r) => { if (live) setRemote(projectRemote(r)); }, () => {});
    return () => { live = false; };
  }, [services]);
  return remote;
}

/** Opens a URL in the user's browser, through the backend (the webview never navigates). */
function useOpen() {
  const toast = useToast((s) => s.show);
  return (url: string) => void api.openUrl(url).catch((e: unknown) => toast(errorMessage(e)));
}

export function LinkedText({ tokens }: { tokens: MessageToken[] }) {
  const open = useOpen();
  return (
    <>
      {tokens.map((t, i) =>
        t.kind === 'text' ? <Fragment key={i}>{t.text}</Fragment> : (
          <a key={i} href={t.url} className="msg-link" onClick={(e) => { e.preventDefault(); open(t.url); }} onAuxClick={(e) => e.preventDefault()}>{t.text}</a>
        ),
      )}
    </>
  );
}

/**
 * The commit message (spec §9.2): the summary and body with URLs and MR/PR references
 * linkified, then one `Open !n` button per distinct merge request, which opens it in the browser.
 */
export function Message({ summary, body, remote }: { summary: string; body: string; remote: ProjectRemote | null }) {
  const open = useOpen();
  const summaryTokens = useMemo(() => tokenizeMessage(summary, remote), [summary, remote]);
  const bodyTokens = useMemo(() => tokenizeMessage(body, remote), [body, remote]);
  const buttons = useMemo(() => mergeRequestButtons([...summaryTokens, ...bodyTokens]), [summaryTokens, bodyTokens]);
  return (
    <>
      <h2 className="details-summary" data-testid="details-summary"><LinkedText tokens={summaryTokens} /></h2>
      {body && <div className="details-body" data-testid="details-body"><LinkedText tokens={bodyTokens} /></div>}
      {buttons.length > 0 && (
        <div className="mr-buttons">
          {buttons.map((b) => (
            <button key={b.url} type="button" className="mr-button" data-url={b.url} onClick={() => open(b.url)}>
              <GitPullRequest size={12} aria-hidden /> {b.label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
