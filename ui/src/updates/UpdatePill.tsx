import { ArrowDownToLine, LoaderCircle, RotateCw, TriangleAlert } from 'lucide-react';
import { useEffect } from 'react';
import { useAppState } from '../app/state';
import { useAppInfo } from '../app/appInfo';
import { HoverTooltip } from '../ui/HoverTooltip';
import { percentOf, releaseOf, useUpdates } from './store';
import './updates.css';

/**
 * The status bar's update pill, left of the Keyboard Shortcuts button: shown only while there's
 * an update (so it takes no room otherwise), the same width in every state (no shift as it
 * moves on). "Update to 0.3.0" starts the download (or, for a build from source or an AUR
 * install, opens the dialog); while downloading it's a small progress bar, the percentage in its
 * tooltip; "Install 0.3.0" and the later states open the update dialog.
 */
export function UpdatePill() {
  const state = useUpdates((s) => s.state);
  const archMethod = useAppState((s) => s.settings.updateArchMethod);
  const kind = useAppInfo((s) => s.info?.installKind);
  useEffect(() => { useUpdates.getState().listen(); }, []);
  const release = releaseOf(state);
  if (!release) return null;
  const { download, openDialog } = useUpdates.getState();
  const v = release.version;
  // An AUR install updates with its helper: nothing to download.
  const viaDialog = !release.asset || (kind === 'arch' && archMethod === 'aur');
  switch (state.state) {
    case 'available':
      return (
        <HoverTooltip content={viaDialog ? `GitBolt ${v} is available` : `Download GitBolt ${v}`}>
          <button type="button" className="sb-update" data-state="available" onClick={() => (viaDialog ? openDialog() : void download())}>
            <ArrowDownToLine size={11} aria-hidden />Update to {v}
          </button>
        </HoverTooltip>
      );
    case 'downloading': {
      const pct = percentOf(state);
      return (
        <HoverTooltip content={`Downloading GitBolt ${v}: ${pct}%`}>
          <button type="button" className="sb-update" data-state="downloading" aria-label={`Downloading GitBolt ${v}, ${pct}%`} onClick={openDialog}>
            <span className="sb-update-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}><span style={{ width: `${pct}%` }} /></span>
          </button>
        </HoverTooltip>
      );
    }
    case 'ready':
      return <button type="button" className="sb-update" data-state="ready" onClick={openDialog}><ArrowDownToLine size={11} aria-hidden />Install {v}</button>;
    case 'installing':
      return <button type="button" className="sb-update" data-state="installing" onClick={openDialog}><LoaderCircle size={11} className="sb-spin" aria-hidden />Installing {v}</button>;
    case 'installed':
      return <button type="button" className="sb-update" data-state="installed" onClick={openDialog}><RotateCw size={11} aria-hidden />Restart to update</button>;
    case 'failed':
      return (
        <HoverTooltip content={state.message}>
          <button type="button" className="sb-update failed" data-state="failed" onClick={openDialog}><TriangleAlert size={11} aria-hidden />Update failed</button>
        </HoverTooltip>
      );
    default:
      return null;
  }
}
