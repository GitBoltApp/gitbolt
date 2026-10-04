import { useState } from 'react';
import { api } from '../../api/client';
import type { ForgeKind } from '../../api/gen/ForgeKind';
import type { ForgeMr } from '../../api/gen/ForgeMr';
import type { ForgeMrDetail } from '../../api/gen/ForgeMrDetail';
import type { MergeMethod } from '../../api/gen/MergeMethod';
import type { MergeOptions } from '../../api/gen/MergeOptions';
import { confirmAction } from '../../ui/ConfirmDialog';
import { Select } from '../../ui/Select';
import { useToast } from '../../ui/toast';
import { forgeName, mrRef } from '../labels';
import { useForge } from '../mrStore';
import { branchesText } from '../mrText';
import { useProjectSettings } from './projectSettings';
import { forgeWrite, putMr } from './writes';

export const METHOD_LABELS: Record<MergeMethod, string> = { merge: 'Merge commit', squash: 'Squash and merge', rebase: 'Rebase and merge', semiLinear: 'Merge commit with semi-linear history', fastForward: 'Fast-forward merge' };

/** A row kept in the layout but not shown (visibility, not display: its space stays). */
const reserved = (hidden: boolean) => (hidden ? { style: { visibility: 'hidden' as const }, 'aria-hidden': true } : {});

/** Why Merge is disabled (spec #4 §2: "disabled with the reason when blocked"); null: it isn't. */
export function mergeBlock(kind: ForgeKind, detail: ForgeMrDetail | null): string | null {
  if (!detail) return 'Loading…';
  const s = detail.mergeStatus;
  if (s.kind === 'checking') return `${forgeName(kind)} is still checking whether it can merge`;
  return s.kind === 'blocked' ? s.reason : null;
}

/**
 * Merge (spec #4 §2, ruling 8). GitLab merges with the project's method; squash follows the
 * project (hidden for Never, locked on for Always) and the MR's own choice; delete-source-branch
 * defaults to the MR's, else the project's. GitHub's method is one of the repository's; its
 * branch deletion is the repository's setting. The click arms in place; the merge sends the head
 * sha the view loaded, so a moved head is refused (Review Focus 3). No optimistic UI: the store
 * changes only with the forge's answer.
 */
export function MergeBox({ tabId, kind, mr, detail }: { tabId: string; kind: ForgeKind; mr: ForgeMr; detail: ForgeMrDetail | null }) {
  const remote = useForge((s) => s.byTab[tabId]?.remote ?? null);
  const { settings, error: settingsError } = useProjectSettings(tabId, remote);
  const [method, setMethod] = useState<MergeMethod | null>(null);
  const [squash, setSquash] = useState<boolean | null>(null);
  const [del, setDel] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  if (mr.state !== 'open' && mr.state !== 'draft') return null;
  const ref = mrRef(kind, mr.number);
  const blocked = mergeBlock(kind, detail) ?? (settings ? null : settingsError ? `Couldn't load merge options: ${settingsError}` : 'Loading merge options…');
  const methods = settings?.mergeMethods ?? [];
  const chosen = method ?? methods[0] ?? null;
  const squashOpt = settings?.squash ?? 'defaultOff';
  const squashOn = squashOpt === 'always' ? true : squashOpt === 'never' ? false : squash ?? detail?.squash ?? squashOpt === 'defaultOn';
  const delOn = del ?? detail?.deleteSourceBranch ?? settings?.deleteSourceBranch ?? false;
  const merge = async () => {
    const ok = await confirmAction({ title: `Merge ${ref}?`, body: branchesText(mr), confirmLabel: 'Merge', arm: `Click again to merge ${ref} into ${mr.targetBranch}`, tone: 'positive' });
    if (!ok) return;
    const expectedSha = detail?.mr.headSha ?? mr.headSha;
    const options: MergeOptions = kind === 'gitlab'
      ? { method: null, squash: squashOpt === 'never' ? null : squashOn, deleteSourceBranch: delOn, expectedSha }
      : { method: chosen, squash: null, deleteSourceBranch: null, expectedSha };
    setBusy(true);
    const out = await forgeWrite(tabId, `Couldn't merge ${ref}`, (repo) => api.forgeMerge(repo, mr.number, options));
    setBusy(false);
    if (!out) return;
    putMr(tabId, out.value);
    useToast.getState().show(`Merged ${ref} into ${mr.targetBranch}`);
  };
  return (
    <section className="mr-merge" aria-label="Merge">
      {/* The rows are reserved while the options load (hidden, not removed), so nothing shifts. */}
      {kind === 'gitlab' && (
        <>
          <div className="mr-dim mr-merge-row" {...reserved(!settings)}>Merge method: {METHOD_LABELS[methods[0] ?? 'merge']}</div>
          <label className="mr-check mr-merge-row" {...reserved(!settings || squashOpt === 'never')}><input type="checkbox" checked={squashOn} disabled={!settings || squashOpt === 'always'} onChange={(e) => setSquash(e.target.checked)} /> Squash commits</label>
          <label className="mr-check mr-merge-row" {...reserved(!settings)}><input type="checkbox" checked={delOn} disabled={!settings} onChange={(e) => setDel(e.target.checked)} /> Delete the source branch</label>
        </>
      )}
      {kind === 'github' && (chosen && methods.length > 1
        ? <div className="mr-field mr-merge-row">Merge method <Select aria-label="Merge method" value={chosen} options={methods.map((m) => [m, METHOD_LABELS[m]] as const)} onChange={(v) => setMethod(v as MergeMethod)} /></div>
        : <div className="mr-dim mr-merge-row" {...reserved(!chosen)}>Merge method: {METHOD_LABELS[chosen ?? 'merge']}</div>)}
      {kind === 'github' && settings?.deleteSourceBranch && <div className="mr-dim">GitHub deletes the branch after merging (repository setting)</div>}
      <div className="mr-form-row">
        <button type="button" className="mr-button primary" disabled={blocked !== null || busy} onClick={() => void merge()}>{busy ? 'Merging…' : 'Merge'}</button>
      </div>
      <p className="mr-merge-reason" role="note" {...reserved(!blocked)}>{blocked ?? '\u00a0'}</p>
    </section>
  );
}
