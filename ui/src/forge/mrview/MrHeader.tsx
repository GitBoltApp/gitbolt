import { api, errorMessage } from '../../api/client';
import type { ForgeKind } from '../../api/gen/ForgeKind';
import type { ForgeMr } from '../../api/gen/ForgeMr';
import type { ForgeMrDetail } from '../../api/gen/ForgeMrDetail';
import { ForgeAvatar } from '../../avatars/Avatar';
import { relativeTime } from '../../format/relative';
import { useToast } from '../../ui/toast';
import { chipStyle } from '../chipStyle';
import { EmojiText } from '../emoji';
import { MrStateIcon, PipelineIcon } from '../MrIcons';
import { MR_STATE_LABELS, ownerOf, pipelineWord, reviewText } from '../mrText';
import { ArrowGlyph } from '../../ui/ArrowGlyph';

export const openInBrowser = (url: string) => {
  api.openUrl(url).catch((e: unknown) => useToast.getState().show(errorMessage(e), { error: true }));
};

const branchLabel = (project: string, mr: ForgeMr, branch: string) => (project !== '' && project !== mr.targetProject ? `${ownerOf(project)}:${branch}` : branch);

/** The view's header (spec #4 §4 "4B"): the state pill and branch chips, the author, a strip of
 * three facts (pipeline, approvals or reviews, conflicts), reviewers, assignees, labels. */
export function MrHeader({ kind, mr, detail }: { kind: ForgeKind; mr: ForgeMr; detail: ForgeMrDetail | null }) {
  const decision = detail?.mr.review.decision;
  const reviewTone = decision === 'approved' ? 'ok' : decision === 'changesRequested' ? 'bad' : '';
  const conflicts = mr.conflicts === null ? { text: 'Checking…', tone: 'dim' } : mr.conflicts ? { text: 'Yes', tone: 'bad' } : { text: 'None', tone: 'ok' };
  const pipeTone = mr.pipeline?.status === 'success' ? 'ok' : mr.pipeline?.status === 'failed' ? 'bad' : mr.pipeline?.status === 'pending' || mr.pipeline?.status === 'running' ? 'warn' : '';
  return (
    <section className="mr-header" aria-label="Summary">
      <div className="mr-line">
        <span className="mr-state" data-state={mr.state}><MrStateIcon state={mr.state} /> {MR_STATE_LABELS[mr.state]}</span>
        <span className="mr-branches"><span className="mr-chip">{branchLabel(mr.sourceProject, mr, mr.sourceBranch)}</span> <ArrowGlyph /> <span className="mr-chip">{mr.targetBranch}</span></span>
      </div>
      <div className="mr-line mr-dim-line">
        <ForgeAvatar user={mr.author} size={20} />
        <span>{mr.author.name}</span>
        <span className="mr-dim">· updated {relativeTime(mr.updatedAt)}</span>
      </div>
      <div className="mr-facts">
        <div className="mr-fact" data-fact="pipeline">
          <div className="mr-fact-k">{kind === 'gitlab' ? 'Pipeline' : 'Checks'}</div>
          <div className={`mr-fact-v ${pipeTone}`}>
            {mr.pipeline && <PipelineIcon pipeline={mr.pipeline} />}
            {mr.pipeline?.webUrl ? <button type="button" className="mr-link" onClick={() => openInBrowser(mr.pipeline!.webUrl!)}>{pipelineWord(mr.pipeline)}</button> : <span>{pipelineWord(mr.pipeline)}</span>}
          </div>
        </div>
        <div className="mr-fact" data-fact="reviews">
          <div className="mr-fact-k">{kind === 'gitlab' ? 'Approvals' : 'Reviews'}</div>
          <div className={`mr-fact-v ${reviewTone}`}>{detail ? reviewText(detail.mr.review) : 'Loading…'}</div>
        </div>
        <div className="mr-fact" data-fact="conflicts">
          <div className="mr-fact-k">Conflicts</div>
          <div className={`mr-fact-v ${conflicts.tone}`}>{conflicts.text}</div>
        </div>
      </div>
      {detail && detail.reviewers.length > 0 && (
        <div className="mr-line mr-dim-line">Reviewers: {detail.reviewers.map((u) => (
          <span key={u.id} className="mr-person"><ForgeAvatar user={u} size={20} /> {u.name}</span>
        ))}</div>
      )}
      {detail && detail.assignees.length > 0 && <div className="mr-line mr-dim-line">Assignees: {detail.assignees.map((u) => u.name).join(', ')}</div>}
      {mr.labels.length > 0 && (
        <div className="mr-labels">
          {mr.labels.map((l) => {
            const color = mr.labelColors && Object.hasOwn(mr.labelColors, l) ? mr.labelColors[l] : undefined;
            return <span key={l} className="mr-label" data-colored={color ? '' : undefined} style={chipStyle(color)}><EmojiText text={l} /></span>;
          })}
        </div>
      )}
    </section>
  );
}
