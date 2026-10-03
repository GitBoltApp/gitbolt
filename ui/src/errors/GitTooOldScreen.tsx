import { useState } from 'react';
import type { GbError } from '../api/gen/GbError';
import { useGitCheck } from './gitCheck';
import './errors.css';

/** The blocking screen (spec §5.5): nothing works without git 2.40 or newer, or without git at all. */
export function GitTooOldScreen({ error }: { error: GbError }) {
  const [busy, setBusy] = useState(false);
  const missing = error.kind !== 'GitTooOld';
  return (
    <div role="alertdialog" aria-labelledby="git-too-old-title" className="git-too-old">
      <h1 id="git-too-old-title">{missing ? 'GitBolt could not run git' : 'GitBolt needs git 2.40 or newer'}</h1>
      <p>{error.message}</p>
      <p>Install or upgrade git, then retry:</p>
      <pre>sudo apt install git</pre>
      <p className="dim">Other systems: https://git-scm.com/downloads</p>
      <button type="button" className="git-too-old-retry" disabled={busy} onClick={() => { setBusy(true); void useGitCheck.getState().retry().finally(() => setBusy(false)); }}>Retry</button>
    </div>
  );
}
