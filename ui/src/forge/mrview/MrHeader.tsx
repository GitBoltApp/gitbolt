import { api, errorMessage } from '../../api/client';
import type { ForgeKind } from '../../api/gen/ForgeKind';
import type { ForgeMr } from '../../api/gen/ForgeMr';
import type { ForgeMrDetail } from '../../api/gen/ForgeMrDetail';
import { useState, type ReactNode } from 'react';
import { ForgeAvatar } from '../../avatars/Avatar';
import { RelTime } from './RelTime';
import { useToast } from '../../ui/toastStore';
import { MrStateChip, PipelineIcon } from '../MrIcons';
import { ownerOf, pipelineWord, reviewText } from '../mrText';
import { useTabForgeField } from '../mrStore';
import { BranchFlow } from '../ui/BranchFlow';
import { useCommitJump } from '../ui/commitJump';
import { useRangeStatsRecheck } from '../ui/rangeStats';
import { compareMr } from './compare';
import { MrPeople } from './MrPeople';

export const openInBrowser = (url: string) => {
  api.openUrl(url).catch((e: unknown) => useToast.getState().show(errorMessage(e), { error: true }));
};

const fromFork = (mr: ForgeMr) => mr.sourceProject !== '' && mr.sourceProject !== mr.targetProject;

/** The view's header (spec #4 §4 "4B"): the status line (the state pill, the author, when, and
 * `actions` at its right end), where it goes (the branch card: source → target, what it brings,
 * its commits jumping to the graph), a strip of three facts (pipeline, approvals or reviews with
 * `review`'s buttons top right, conflicts; both gone while `editing`, when the Edit form has the
 * people), and reviewers, assignees and labels (`MrPeople`). */
export function MrHeader({ tabId, kind, mr, detail, actions, review, editLabels, editing = false }: { tabId: string; kind: ForgeKind; mr: ForgeMr; detail: ForgeMrDetail | null; actions?: ReactNode; review?: ReactNode; editLabels?: () => void; editing?: boolean }) {
  const remote = useTabForgeField(tabId, 'remote');
  // Counted locally while it's open (a merged one's head is in its target: nothing to count).
  const open = mr.state === 'open' || mr.state === 'draft';
  const jump = useCommitJump(tabId);
  // Compare's spinner: while it fetches the head (when it must) and finds the base.
  const [comparing, setComparing] = useState(false);
  const [stats, recheck] = useRangeStatsRecheck(tabId, open ? detail?.mr.headSha ?? mr.headSha : null, open && remote ? `refs/remotes/${remote}/${mr.targetBranch}` : null);
  const none = mr.state === 'merged' ? `Merged into ${mr.targetBranch}` : mr.state === 'closed' ? 'Closed' : "Its commits aren't fetched into this repository";
  const decision = detail?.mr.review.decision;
  const reviewTone = decision === 'approved' ? 'ok' : decision === 'changesRequested' ? 'bad' : '';
  const conflicts = mr.conflicts === null ? { text: 'Checking…', tone: 'dim' } : mr.conflicts ? { text: 'Yes', tone: 'bad' } : { text: 'None', tone: 'ok' };
  const pipeTone = mr.pipeline?.status === 'success' ? 'ok' : mr.pipeline?.status === 'failed' ? 'bad' : mr.pipeline?.status === 'pending' || mr.pipeline?.status === 'running' ? 'warn' : '';
  return (
    <section className="mr-header" aria-label="Summary">
      <div className="mr-line mr-dim-line">
        <MrStateChip state={mr.state} />
        <ForgeAvatar user={mr.author} size={20} />
        <span className="mr-author">{mr.author.name}</span>
        <RelTime at={mr.updatedAt} prefix="updated" className="mr-dim" />
        {actions && <span className="mr-spacer" />}
        {actions}
      </div>
      <BranchFlow
        from={{ branch: mr.sourceBranch, sub: fromFork(mr) ? ownerOf(mr.sourceProject) : mr.targetProject }}
        into={{ branch: mr.targetBranch, sub: mr.targetProject }}
        stats={stats}
        none={none}
        recheck={open ? recheck : undefined}
        jump={jump}
        compare={(detail?.mr.headSha ?? mr.headSha) ? { busy: comparing, run: () => { setComparing(true); void compareMr(tabId, kind, mr, detail).finally(() => setComparing(false)); } } : undefined}
      />
      {!editing && <div className="mr-facts">
        <div className="mr-fact" data-fact="pipeline">
          <div className="mr-fact-k">{kind === 'gitlab' ? 'Pipeline' : 'Checks'}</div>
          <div className={`mr-fact-v ${pipeTone}`}>
            {mr.pipeline && <PipelineIcon pipeline={mr.pipeline} />}
            {mr.pipeline?.webUrl ? <button type="button" className="mr-link" onClick={() => openInBrowser(mr.pipeline!.webUrl!)}>{pipelineWord(mr.pipeline)}</button> : <span>{pipelineWord(mr.pipeline)}</span>}
          </div>
        </div>
        <div className="mr-fact" data-fact="reviews">
          <div className="mr-fact-head">
            <div className="mr-fact-k">{kind === 'gitlab' ? 'Approvals' : 'Reviews'}</div>
            {review}
          </div>
          <div className={`mr-fact-v ${reviewTone}`}>{detail ? reviewText(detail.mr.review) : 'Loading…'}</div>
        </div>
        <div className="mr-fact" data-fact="conflicts">
          <div className="mr-fact-k">Conflicts</div>
          <div className={`mr-fact-v ${conflicts.tone}`}>{conflicts.text}</div>
        </div>
        {/* The people and labels cards share this grid (their own wrapper is display: contents
            here), so the six cards wrap as one set with no gaps. */}
        <MrPeople tabId={tabId} kind={kind} mr={mr} detail={detail} editLabels={editLabels} />
      </div>}
    </section>
  );
}
