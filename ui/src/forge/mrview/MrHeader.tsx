import { api, errorMessage } from '../../api/client';
import type { ForgeKind } from '../../api/gen/ForgeKind';
import type { ForgeMr } from '../../api/gen/ForgeMr';
import type { ForgeMrDetail } from '../../api/gen/ForgeMrDetail';
import { Avatar } from '../../avatars/Avatar';
import { relativeTime } from '../../format/relative';
import { useToast } from '../../ui/toast';
import { MrStateIcon, PipelineIcon } from '../MrIcons';
import { branchesText, conflictText, MR_STATE_LABELS, pipelineText, reviewText } from '../mrText';

export const openInBrowser = (url: string) => {
  api.openUrl(url).catch((e: unknown) => useToast.getState().show(errorMessage(e), { error: true }));
};

/** The view's header (spec #4 §4 "4B"): state, branches, author, pipeline, reviewers and
 * approvals, conflicts, labels. */
export function MrHeader({ kind, mr, detail }: { kind: ForgeKind; mr: ForgeMr; detail: ForgeMrDetail | null }) {
  const pipeline = pipelineText(kind, mr.pipeline);
  return (
    <section className="mr-header" aria-label="Summary">
      <div className="mr-line">
        <span className="mr-state" data-state={mr.state}><MrStateIcon state={mr.state} /> {MR_STATE_LABELS[mr.state]}</span>
        <span className="mr-branches">{branchesText(mr)}</span>
      </div>
      <div className="mr-line">
        <Avatar name={mr.author.name} email={mr.author.email ?? ''} size={16} request={!!mr.author.email} />
        <span>{mr.author.name}</span>
        <span className="mr-dim">· updated {relativeTime(mr.updatedAt)}</span>
      </div>
      <div className="mr-line">
        {mr.pipeline && <PipelineIcon pipeline={mr.pipeline} />}
        {mr.pipeline?.webUrl ? <button type="button" className="mr-link" onClick={() => openInBrowser(mr.pipeline!.webUrl!)}>{pipeline}</button> : <span>{pipeline}</span>}
      </div>
      <div className="mr-line">{detail ? reviewText(detail.mr.review) : 'Loading…'}</div>
      <div className="mr-line">{conflictText(mr.conflicts)}</div>
      {detail && detail.reviewers.length > 0 && <div className="mr-line">Reviewers: {detail.reviewers.map((u) => u.name).join(', ')}</div>}
      {detail && detail.assignees.length > 0 && <div className="mr-line">Assignees: {detail.assignees.map((u) => u.name).join(', ')}</div>}
      {mr.labels.length > 0 && <div className="mr-labels">{mr.labels.map((l) => <span key={l} className="mr-label">{l}</span>)}</div>}
    </section>
  );
}
