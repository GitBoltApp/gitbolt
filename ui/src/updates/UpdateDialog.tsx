import { Copy, ExternalLink } from 'lucide-react';
import { lazy, Suspense, type ReactNode } from 'react';
import { api } from '../api/client';
import type { InstallKind } from '../api/gen/InstallKind';
import type { UpdateRelease } from '../api/gen/UpdateRelease';
import type { UpdateState } from '../api/gen/UpdateState';
import { copyText } from '../api/transport';
import { useAppInfo } from '../app/appInfo';
import { useModalKeys } from '../app/modalKeys';
import { useAppState } from '../app/state';
import { useToast } from '../ui/toastStore';
import { formatSize, percentOf, releaseOf, useUpdates } from './store';
import './updates.css';

const ReleaseNotes = lazy(() => import('./ReleaseNotes'));

/** What an AUR install runs instead (there's no `gitbolt-bin` on the AUR yet: "if you installed
 * from the AUR"). */
export const AUR_COMMANDS = ['yay -S gitbolt-bin', 'paru -S gitbolt-bin'] as const;

function copy(text: string) {
  void copyText(text).then(() => useToast.getState().show('Copied'), () => useToast.getState().show('Copy failed'));
}

/** A command to run in a terminal, with Copy. */
function Command({ text }: { text: string }) {
  return (
    <div className="update-command">
      <code>{text}</code>
      <button type="button" aria-label={`Copy ${text}`} onClick={() => copy(text)}><Copy size={12} aria-hidden /> Copy</button>
    </div>
  );
}

/** What the install button does, per install kind. */
const INSTALL_NOTE: Record<Exclude<InstallKind, 'none'>, string> = {
  deb: 'GitBolt installs the package with apt; your system asks for your password.',
  arch: 'GitBolt installs the package with pacman; your system asks for your password.',
  nsis: 'The installer opens, and GitBolt closes so it can be replaced.',
  msi: 'Windows Installer opens (and may ask for permission), and GitBolt closes so it can be replaced.',
  dmg: 'GitBolt copies the new version from the disk image over this one; then restart it.',
};

/** The dialog's middle: what can be done now, for this install. */
function Action({ state, release, kind }: { state: UpdateState; release: UpdateRelease; kind: InstallKind }) {
  const { download, cancel, install } = useUpdates.getState();
  const outcome = useUpdates((s) => s.outcome);
  const archMethod = useAppState((s) => s.settings.updateArchMethod);
  if (!release.asset || kind === 'none') {
    return <p className="update-message">{kind === 'none' ? 'This GitBolt was built from source: get the new version from its release page.' : `This release has no package for this install: get it from its release page.`}</p>;
  }
  const arch = kind === 'arch' ? (
    <div className="update-choices" role="group" aria-label="How do you install GitBolt?">
      <button type="button" aria-pressed={archMethod === 'pacman'} onClick={() => useAppState.getState().setSettings({ updateArchMethod: 'pacman' })}>Install with pacman</button>
      <button type="button" aria-pressed={archMethod === 'aur'} onClick={() => useAppState.getState().setSettings({ updateArchMethod: 'aur' })}>I use an AUR helper</button>
    </div>
  ) : null;
  if (kind === 'arch' && archMethod === 'aur') {
    return (
      <>
        {arch}
        <p className="update-message">If you installed GitBolt from the AUR, update it with your helper:</p>
        {AUR_COMMANDS.map((c) => <Command key={c} text={c} />)}
      </>
    );
  }
  switch (state.state) {
    case 'available':
      return <>{arch}<p className="update-message">Download the package, check it against the release&apos;s SHA256SUMS, then install it.</p><div className="modal-actions"><button type="button" className="primary" onClick={() => void download()}>Download</button></div></>;
    case 'downloading': {
      const pct = percentOf(state);
      return (
        <div className="update-progress">
          <span className="sb-update-bar" role="progressbar" aria-label="Download" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}><span style={{ width: `${pct}%` }} /></span>
          <span>{pct}%</span>
          <button type="button" onClick={() => void cancel()}>Cancel</button>
        </div>
      );
    }
    case 'ready':
    case 'installing': {
      const busy = state.state === 'installing';
      const needsChoice = kind === 'arch' && !archMethod;
      return (
        <>
          {arch}
          {needsChoice ? <p className="update-message">How did you install GitBolt? GitBolt remembers your answer.</p> : <p className="update-message">{INSTALL_NOTE[kind]}</p>}
          {outcome?.outcome === 'manual' && (
            <>
              <p className="update-message error" role="alert">{outcome.reason}</p>
              {/* The package manager's own words, apart from GitBolt's: what to search for or report. */}
              {outcome.output && <pre className="update-output" aria-label="Package manager output">{outcome.output}</pre>}
              <p className="update-message">Run this in a terminal instead:</p>
              <Command text={outcome.command} />
            </>
          )}
          {!needsChoice && <div className="modal-actions"><button type="button" className="primary" disabled={busy} onClick={() => void install()}>{busy ? 'Installing…' : `Install ${release.version}`}</button></div>}
        </>
      );
    }
    case 'installed':
      return (
        <>
          <p className="update-message">GitBolt {release.version} is installed. Restart GitBolt to use it.</p>
          <div className="modal-actions"><button type="button" className="primary" onClick={() => void useUpdates.getState().restart()}>Restart GitBolt</button></div>
        </>
      );
    case 'failed':
      return (
        <>
          <p className="update-message error">{state.message}</p>
          <div className="modal-actions"><button type="button" className="primary" onClick={() => void download()}>Download again</button></div>
        </>
      );
    default:
      return null;
  }
}

/**
 * The update dialog (from the status bar's pill, or About): the release's notes, rendered; its
 * package and size; and what installs it on this machine (the install kind the package baked
 * in). A build from source, or a release without this install's package, only links to the
 * release page. View on GitHub opens it in the browser.
 */
export function UpdateDialog() {
  const open = useUpdates((s) => s.dialogOpen);
  const state = useUpdates((s) => s.state);
  const error = useUpdates((s) => s.error);
  const info = useAppInfo((s) => s.info);
  const close = () => useUpdates.getState().closeDialog();
  const ref = useModalKeys<HTMLDivElement>(open, close);
  const release = releaseOf(state);
  if (!open || !release) return null;
  const kind: InstallKind = info?.installKind ?? 'none';
  let file: ReactNode = null;
  if (release.asset && kind !== 'none') file = <p className="update-file">{release.asset.name} · {formatSize(release.asset.size)}</p>;
  return (
    <div className="modal-backdrop" onPointerDown={close}>
      <div ref={ref} className="modal update-dialog" role="dialog" aria-label={`Update to GitBolt ${release.version}`} onPointerDown={(e) => e.stopPropagation()}>
        <h2>{release.name}{release.prerelease && <span className="update-badge">Pre-release</span>}</h2>
        <p className="update-sub">You have GitBolt {info?.appVersion ?? '…'}.</p>
        <div className="update-notes" tabIndex={0} aria-label="Release notes">
          {release.notes.trim()
            ? <Suspense fallback={<p aria-busy="true">Loading…</p>}><ReleaseNotes text={release.notes} /></Suspense>
            : <p className="update-notes-empty">No release notes.</p>}
        </div>
        {file}
        <Action state={state} release={release} kind={kind} />
        {error && <p className="update-message error" role="alert">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="update-link" onClick={() => void api.openUrl(release.url)}><ExternalLink size={12} aria-hidden /> View on GitHub</button>
          <button type="button" autoFocus onClick={close}>Close</button>
        </div>
      </div>
    </div>
  );
}
