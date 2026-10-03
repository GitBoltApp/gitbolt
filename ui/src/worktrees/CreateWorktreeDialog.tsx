import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { api, errorMessage } from '../api/client';
import type { WorktreeBranch } from '../api/gen/WorktreeBranch';
import { useModalKeys } from '../app/modalKeys';
import { registerAppSlot } from '../app/slots';
import { useRuntime } from '../app/runtime';
import { branchNameError } from '../branches/branchName';
import { runWrite } from '../write/client';
import { openWorktreeTab } from './active';

/** What opened the dialog: the commit, and a branch it starts from (an existing local branch that
 * isn't checked out, or a remote one), or none (a new name at the commit). */
interface Req { tabId: string; at: string; branch: WorktreeBranch | null }
const useDialog = create<{ req: Req | null }>(() => ({ req: null }));
export const openCreateWorktree = (req: Req) => useDialog.setState({ req });

const branchOf = (b: WorktreeBranch | null) => (b?.kind === 'existing' ? b.name : b?.kind === 'remote' ? b.name : '');

export function CreateWorktreeDialog() {
  const req = useDialog((s) => s.req);
  if (!req) return null;
  return <Form req={req} key={`${req.at}:${branchOf(req.branch)}`} />;
}

function Form({ req }: { req: Req }) {
  const rt = useRuntime((s) => s.tabs[req.tabId]);
  const [name, setName] = useState(branchOf(req.branch));
  const [path, setPath] = useState('');
  const [edited, setEdited] = useState(false);
  const [openTab, setOpenTab] = useState(true);
  const [suggestError, setSuggestError] = useState<string | null>(null);
  const close = () => useDialog.setState({ req: null });
  const ref = useModalKeys<HTMLDivElement>(true, close);
  const existing = req.branch?.kind === 'existing';
  const taken = !existing && !!rt?.sidebar?.locals.some((b) => b.name === name);
  const error = existing ? null : branchNameError(name) ?? (taken ? `A branch named ${name} already exists` : null);
  // The folder follows the branch name until the user edits it (§11.1: dash-joined, -2 when taken).
  useEffect(() => {
    if (edited || !rt?.repo || !name || branchNameError(name)) return;
    let live = true;
    void api.suggestWorktreePath(rt.repo.id, name).then((p) => { if (live) { setSuggestError(null); setPath(p); } }, (e) => { if (live) setSuggestError(`Couldn't suggest a directory (${errorMessage(e)}): type one`); });
    return () => { live = false; };
  }, [name, edited, rt?.repo]);
  const submit = async () => {
    if (!rt?.repo || error || !path) return;
    const branch: WorktreeBranch = req.branch?.kind === 'remote' ? { ...req.branch, name } : existing ? req.branch! : { kind: 'new', name, at: req.at };
    close();
    const ctx = { tabId: req.tabId, repoId: rt.repo.id, worktree: rt.worktree ?? rt.repo.path };
    const out = await runWrite(ctx, () => api.worktreeAdd(ctx.repoId, ctx.worktree, path, branch));
    if (out && openTab) await openWorktreeTab(req.tabId, out.path);
  };
  const browse = async () => {
    const picked = await api.pickFolder(path ? path.slice(0, path.lastIndexOf('/')) : null);
    if (picked) { setEdited(true); setPath(picked); }
  };
  return (
    <div className="modal-backdrop" onPointerDown={close}>
      <div ref={ref} className="modal" role="dialog" aria-modal="true" aria-labelledby="wt-title" onPointerDown={(e) => e.stopPropagation()}>
        <h2 id="wt-title">Create worktree</h2>
        <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <label className="modal-field">
            <span>{existing ? 'Branch' : 'New branch'}</span>
            <input aria-label={existing ? 'Branch' : 'New branch'} value={name} readOnly={existing} autoFocus={!existing} onChange={(e) => setName(e.target.value)} spellCheck={false} />
          </label>
          {error && name && <p role="alert" className="modal-error">{error}</p>}
          <label className="modal-field">
            <span>Directory</span>
            <input aria-label="Directory" value={path} onChange={(e) => { setEdited(true); setPath(e.target.value); }} spellCheck={false} />
            <button type="button" onClick={() => void browse()}>Browse…</button>
          </label>
          {suggestError && !path && <p role="alert" className="modal-error">{suggestError}</p>}
          <label className="modal-check">
            <input type="checkbox" checked={openTab} onChange={(e) => setOpenTab(e.target.checked)} /> Open in a new tab
          </label>
          <div className="modal-actions">
            <button type="button" onClick={close}>Cancel</button>
            <button type="submit" disabled={!!error || !path}>Create worktree</button>
          </div>
        </form>
      </div>
    </div>
  );
}

export const offCreateWorktreeDialog = registerAppSlot('overlay', 'createWorktree', CreateWorktreeDialog);
