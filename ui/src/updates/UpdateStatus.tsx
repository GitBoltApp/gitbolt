import { releaseOf, useUpdates } from './store';
import './updates.css';

/** About's update line: Check for updates, and what the check found. "Show update" opens the
 *  update dialog (About closes under it). */
export function UpdateStatus({ onShow }: { onShow?: () => void }) {
  const state = useUpdates((s) => s.state);
  const checkError = useUpdates((s) => s.checkError);
  const { check, openDialog } = useUpdates.getState();
  const release = releaseOf(state);
  const checking = state.state === 'checking';
  let text: string | null = null;
  if (checking) text = 'Checking for updates…';
  else if (checkError) text = `Couldn't check for updates: ${checkError}`;
  else if (state.state === 'upToDate') text = 'GitBolt is up to date.';
  else if (release && state.state === 'installed') text = `GitBolt ${release.version} is installed: restart to use it.`;
  else if (release) text = `GitBolt ${release.version} is available.`;
  return (
    <div className="update-about">
      <p className={checkError ? 'update-message error' : 'update-message'} role="status">{text ?? ' '}</p>
      <div className="modal-actions">
        {release && <button type="button" onClick={() => { onShow?.(); openDialog(); }}>Show update</button>}
        <button type="button" disabled={checking} onClick={() => void check()}>Check for updates</button>
      </div>
    </div>
  );
}
