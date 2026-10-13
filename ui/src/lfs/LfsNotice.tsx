import { TriangleAlert } from 'lucide-react';
import { api, errorMessage } from '../api/client';
import { useRuntime } from '../app/runtime';
import { useAppState } from '../app/state';
import { useToast } from '../ui/toastStore';
import { useLfsStatus } from './store';

/** The status bar's warning for the active tab's repository when it uses Git LFS and git-lfs
 * isn't installed, with a link to the install instructions (opened in the browser). */
export function LfsNotice() {
  const activeTab = useAppState((s) => s.profile.activeTab);
  const repo = useRuntime((s) => (activeTab ? s.tabs[activeTab]?.repo?.id ?? -1 : -1));
  const status = useLfsStatus(repo);
  if (!status?.used || status.version) return null;
  const open = () => { api.openUrl(status.installUrl).catch((e: unknown) => useToast.getState().show(`Couldn't open ${status.installUrl}: ${errorMessage(e)}`, { error: true })); };
  return (
    <span className="sb-item sb-warn" data-testid="lfs-missing">
      <TriangleAlert size={12} aria-hidden /> This repository uses Git LFS, but git-lfs isn't installed: files check out as pointers
      <button type="button" className="sb-link" onClick={open}>Install git-lfs</button>
    </span>
  );
}
