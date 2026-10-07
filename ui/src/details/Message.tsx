import { GitPullRequest } from 'lucide-react';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { api, errorMessage } from '../api/client';
import { effectiveKind } from '../forge/urls';
import type { RepoServices } from '../repo/services';
import { useAppState } from '../app/state';
import { useToast } from '../ui/toastStore';
import { mergeRequestButtons, projectRemote, tokenizeMessage, type MessageToken, type ProjectRemote } from './messageLinks';
import './header.css';

/** The remote that message references point at (spec §14.4): the first with a parsed host.
 * `services.remotesSnapshot()` is the one cache of "this repo's remotes, loaded" (also read by
 * the file menu's env, `menu/menuEnv.ts`), so a remount (e.g. back from the WIP row) links the
 * message in its first render instead of re-rendering it once the remotes resolve (F12). */
export function useProjectRemote(services: RepoServices): ProjectRemote | null {
  const overrides = useAppState((s) => s.profile.hostOverrides);
  const [state, setState] = useState<{ services: RepoServices; remote: ProjectRemote | null } | null>(null);
  useEffect(() => {
    if (services.remotesSnapshot()) return;
    let live = true;
    services.remotes().then((r) => {
      if (live) setState({ services, remote: projectRemote(r, overrides) });
    }, () => {});
    return () => { live = false; };
    // The overrides apply below; this only waits for the remotes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [services]);
  const snapshot = services.remotesSnapshot();
  const base = snapshot ? snapshot : null;
  return useMemo(() => {
    if (base) return projectRemote(base, overrides);
    if (state?.services !== services || !state.remote) return null;
    return { ...state.remote, hostKind: effectiveKind(state.remote.host, state.remote.hostKind, overrides) };
  }, [base, state, services, overrides]);
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
          <a key={i} href={t.url} className="msg-link" draggable={false} onClick={(e) => { e.preventDefault(); open(t.url); }} onAuxClick={(e) => e.preventDefault()}>{t.text}</a>
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
