import { GitBranch, X } from 'lucide-react';
import { create } from 'zustand';
import { api } from '../api/client';
import { registerAppSlot } from '../app/slots';
import { useRuntime } from '../app/runtime';
import { promptText } from '../ui/PromptDialog';
import { RefPicker, type PickItem } from '../ui/RefPicker';
import { runWrite, type WriteCtx } from '../write/client';
import { branchNameError } from './branchName';

interface Req { ctx: WriteCtx; branch: string; anchor: DOMRect }
const usePicker = create<{ req: Req | null }>(() => ({ req: null }));

/** Set upstream (§9.1; 2D's Push ▾ "Change upstream" too): a remote branch, or None. */
export function pickUpstream(ctx: WriteCtx, branch: string, anchor: DOMRect): void {
  usePicker.setState({ req: { ctx, branch, anchor } });
}

const NONE = '\u0000none';
const NEW = '\u0000new';

/** "A branch the next push creates" (§9.1): `<remote>/<name>`, split at the longest known remote
 * (a remote's name may hold `/`). */
async function askNew(req: Req, remotes: string[]): Promise<void> {
  const split = (v: string) => {
    const remote = [...remotes].sort((a, b) => b.length - a.length).find((r) => v.startsWith(`${r}/`));
    return remote && v.length > remote.length + 1 ? { remote, branch: v.slice(remote.length + 1) } : null;
  };
  const answer = await promptText({
    title: `Track a new remote branch with ${req.branch}`,
    label: 'Remote branch',
    initial: `${remotes[0] ?? 'origin'}/${req.branch}`,
    confirmLabel: 'Set upstream',
    validate: (v) => { const s = split(v); return s ? branchNameError(s.branch) : 'Start with a remote name, e.g. origin/'; },
  });
  const up = answer && split(answer.value);
  if (up) await runWrite(req.ctx, () => api.setUpstream(req.ctx.repoId, req.ctx.worktree, req.branch, up));
}

function UpstreamPicker() {
  const req = usePicker((s) => s.req);
  const sidebar = useRuntime((s) => (req ? s.tabs[req.ctx.tabId]?.sidebar : null));
  if (!req || !sidebar) return null;
  const current = sidebar.locals.find((b) => b.name === req.branch)?.upstream ?? null;
  const items: PickItem[] = [
    { id: NONE, label: 'None', icon: X, current: current === null, detail: 'Track nothing', tooltip: `${req.branch} tracks no remote branch` },
    { id: NEW, label: 'A branch the next push creates…', icon: GitBranch, detail: 'Type its name', tooltip: "Name a remote branch that doesn't exist yet" },
    // Same-named branches first, then the rest, by remote.
    ...sidebar.remotes
      .flatMap((g) => g.branches.map((b) => ({ id: `${g.name}\u0000${b.name}`, label: `${g.name}/${b.name}`, icon: GitBranch, current: current === b.fullName, tooltip: `Track ${g.name}/${b.name}`, sameName: b.name === req.branch })))
      .sort((a, b) => Number(b.sameName) - Number(a.sameName))
      .map(({ sameName: _same, ...item }) => item),
  ];
  const close = () => usePicker.setState({ req: null });
  const pick = (item: PickItem) => {
    close();
    if (item.id === NEW) return void askNew(req, sidebar.remotes.map((g) => g.name));
    const [remote, branch] = item.id.split('\u0000');
    const upstream = item.id === NONE ? null : { remote, branch };
    void runWrite(req.ctx, () => api.setUpstream(req.ctx.repoId, req.ctx.worktree, req.branch, upstream));
  };
  return <RefPicker anchor={req.anchor} placeholder={`Upstream of ${req.branch}`} items={items} onClose={close} onPick={pick} />;
}

export const offUpstreamPicker = registerAppSlot('overlay', 'upstreamPicker', UpstreamPicker);
