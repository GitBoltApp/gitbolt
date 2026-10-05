import { api, errorMessage } from '../../api/client';
import type { ForgeKind } from '../../api/gen/ForgeKind';
import type { ForgeMr } from '../../api/gen/ForgeMr';
import type { ForgeMrDetail } from '../../api/gen/ForgeMrDetail';
import { ForgeAvatar } from '../../avatars/Avatar';
import { relativeTime } from '../../format/relative';
import { useToast } from '../../ui/toast';
import { MrStateIcon, PipelineIcon } from '../MrIcons';
import { MR_STATE_LABELS, ownerOf, pipelineWord, reviewText } from '../mrText';
import { useTabForgeField } from '../mrStore';
import { BranchFlow } from '../ui/BranchFlow';
import { PeopleCard, type PeopleChip } from '../ui/PeopleCard';
import { useRangeStats } from '../ui/rangeStats';
import type { ForgeUser } from '../../api/gen/ForgeUser';

export const openInBrowser = (url: string) => {
  api.openUrl(url).catch((e: unknown) => useToast.getState().show(errorMessage(e), { error: true }));
};

const fromFork = (mr: ForgeMr) => mr.sourceProject !== '' && mr.sourceProject !== mr.targetProject;
const userChip = (u: ForgeUser): PeopleChip => ({ key: String(u.id), label: u.name, user: u });

/** The view's header (spec #4 §4 "4B"): the state pill and the author, where it goes (the branch
 * card: source → target, what it brings), a strip of three facts (pipeline, approvals or reviews,
 * conflicts), and reviewers, assignees and labels (the people card, read-only). */
export function MrHeader({ tabId, kind, mr, detail }: { tabId: string; kind: ForgeKind; mr: ForgeMr; detail: ForgeMrDetail | null }) {
  const remote = useTabForgeField(tabId, 'remote');
  // Counted locally while it's open (a merged one's head is in its target: nothing to count).
  const open = mr.state === 'open' || mr.state === 'draft';
  const stats = useRangeStats(tabId, open ? detail?.mr.headSha ?? mr.headSha : null, open && remote ? `refs/remotes/${remote}/${mr.targetBranch}` : null);
  const none = mr.state === 'merged' ? `Merged into ${mr.targetBranch}` : mr.state === 'closed' ? 'Closed' : "Its commits aren't fetched into this repository";
  const decision = detail?.mr.review.decision;
  const reviewTone = decision === 'approved' ? 'ok' : decision === 'changesRequested' ? 'bad' : '';
  const conflicts = mr.conflicts === null ? { text: 'Checking…', tone: 'dim' } : mr.conflicts ? { text: 'Yes', tone: 'bad' } : { text: 'None', tone: 'ok' };
  const pipeTone = mr.pipeline?.status === 'success' ? 'ok' : mr.pipeline?.status === 'failed' ? 'bad' : mr.pipeline?.status === 'pending' || mr.pipeline?.status === 'running' ? 'warn' : '';
  return (
    <section className="mr-header" aria-label="Summary">
      <div className="mr-line mr-dim-line">
        <span className="mr-state" data-state={mr.state}><MrStateIcon state={mr.state} /> {MR_STATE_LABELS[mr.state]}</span>
        <ForgeAvatar user={mr.author} size={20} />
        <span className="mr-author">{mr.author.name}</span>
        <span className="mr-dim">· updated {relativeTime(mr.updatedAt)}</span>
      </div>
      <BranchFlow
        from={{ branch: mr.sourceBranch, sub: fromFork(mr) ? ownerOf(mr.sourceProject) : mr.targetProject }}
        into={{ branch: mr.targetBranch, sub: mr.targetProject }}
        stats={stats}
        none={none}
      />
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
      <PeopleCard
        label="Reviewers, assignees and labels"
        rows={[
          { label: 'Reviewers', noun: 'reviewer', chips: detail ? detail.reviewers.map(userChip) : null },
          { label: 'Assignees', noun: 'assignee', chips: detail ? detail.assignees.map(userChip) : null },
          { label: 'Labels', noun: 'label', chips: mr.labels.map((l) => ({ key: l, label: l, color: mr.labelColors && Object.hasOwn(mr.labelColors, l) ? mr.labelColors[l] : null })) },
        ]}
      />
    </section>
  );
}
