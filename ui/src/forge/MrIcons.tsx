import { CircleCheck, CircleDashed, CircleSlash, CircleX, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, Hand, LoaderCircle, type LucideIcon } from 'lucide-react';
import type { ForgePipeline } from '../api/gen/ForgePipeline';
import type { MrState } from '../api/gen/MrState';
import type { PipelineStatus } from '../api/gen/PipelineStatus';
import './mr.css';

const STATE_ICONS: Record<MrState, LucideIcon> = { open: GitPullRequest, draft: GitPullRequestDraft, merged: GitMerge, closed: GitPullRequestClosed };
const PIPELINE_ICONS: Record<PipelineStatus, LucideIcon> = { pending: CircleDashed, running: LoaderCircle, success: CircleCheck, failed: CircleX, canceled: CircleSlash, skipped: CircleSlash, manual: Hand };

/** The badge's icon: one per state, coloured by it (mr.css). Decorative: callers name it. */
export function MrStateIcon({ state, size = 12 }: { state: MrState; size?: number }) {
  const Icon = STATE_ICONS[state];
  return <Icon size={size} className="mr-state-icon" data-state={state} aria-hidden />;
}

export function PipelineIcon({ pipeline, size = 12 }: { pipeline: ForgePipeline; size?: number }) {
  const Icon = PIPELINE_ICONS[pipeline.status];
  return <Icon size={size} className={`mr-pipeline-icon${pipeline.status === 'running' ? ' spin' : ''}`} data-status={pipeline.status} aria-hidden />;
}
