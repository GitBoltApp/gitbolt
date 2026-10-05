import { Check, Clock, X } from 'lucide-react';
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
  const { tone, title } = status(blocked, detail, settings !== null || settingsError !== null);
  const summary = tone === 'ready' ? readySummary(mr, detail) : null;
  const Icon = tone === 'ready' ? Check : tone === 'bad' ? X : Clock;
  const methodLine = <span className="mr-dim mr-merge-method mr-merge-row" {...reserved(!settings && !chosen)}>Merge method: {METHOD_LABELS[(kind === 'gitlab' ? methods[0] : chosen) ?? 'merge']}</span>;
  return (
    <section className="mr-merge" aria-label="Merge">
      <div className="mr-merge-top">
        <span className={`mr-merge-dot ${tone}`} aria-hidden><Icon size={13} /></span>
        <div className="mr-merge-ttl">
          <b>{title}</b>
          {/* Always in the layout: the reason, or what is ready, or an empty line. */}
          <span className={`mr-merge-reason ${tone}`} role="note">{blocked ?? summary ?? '\u00a0'}</span>
        </div>
        <button type="button" className="mr-button merge" disabled={blocked !== null || busy} onClick={() => void merge()}>{busy ? 'Merging…' : 'Merge'}</button>
      </div>
      {/* The rows are reserved while the options load (hidden, not removed), so nothing shifts. */}
      <div className="mr-merge-opts">
        {kind === 'gitlab' && (
          <>
            <label className="mr-check mr-merge-row" {...reserved(!settings || squashOpt === 'never')}><input type="checkbox" checked={squashOn} disabled={!settings || squashOpt === 'always'} onChange={(e) => setSquash(e.target.checked)} /> Squash commits</label>
            <label className="mr-check mr-merge-row" {...reserved(!settings)}><input type="checkbox" checked={delOn} disabled={!settings} onChange={(e) => setDel(e.target.checked)} /> Delete the source branch</label>
            {methodLine}
          </>
        )}
        {kind === 'github' && (
          <>
            {settings?.deleteSourceBranch && <span className="mr-dim">GitHub deletes the branch after merging (repository setting)</span>}
            {chosen && methods.length > 1
              ? <div className="mr-field mr-merge-row mr-merge-method">Merge method <Select aria-label="Merge method" value={chosen} options={methods.map((m) => [m, METHOD_LABELS[m]] as const)} onChange={(v) => setMethod(v as MergeMethod)} /></div>
              : methodLine}
          </>
        )}
      </div>
    </section>
  );
}

export type MergeTone = 'ready' | 'wait' | 'bad';

/** The merge box's icon colour and bold title, from why Merge is (not) allowed. */
function status(blocked: string | null, detail: ForgeMrDetail | null, loaded: boolean): { tone: MergeTone; title: string } {
  if (blocked === null) return { tone: 'ready', title: 'Ready to merge' };
  if (!detail || detail.mergeStatus.kind === 'checking' || (!loaded && detail.mergeStatus.kind === 'mergeable')) return { tone: 'wait', title: 'Checking…' };
  if (/schedul/i.test(blocked)) return { tone: 'wait', title: 'Merge is scheduled' };
  if (/conflict|fail|couldn't|can't|cannot|merged already/i.test(blocked)) return { tone: 'bad', title: 'Merge is blocked' };
  return { tone: 'wait', title: 'Merge is blocked' };
}

/** "Pipeline passed · approved": what makes it ready, when the forge says. */
function readySummary(mr: ForgeMr, detail: ForgeMrDetail | null): string | null {
  const bits: string[] = [];
  if (mr.pipeline?.status === 'success') bits.push('Pipeline passed');
  if ((detail?.mr.review.decision ?? mr.review.decision) === 'approved') bits.push('approved');
  return bits.length ? bits.join(' · ').replace(/^./, (c) => c.toUpperCase()) : null;
}
