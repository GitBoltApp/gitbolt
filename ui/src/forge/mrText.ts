import type { ForgeKind } from '../api/gen/ForgeKind';
import type { ForgeMr } from '../api/gen/ForgeMr';
import type { ForgePipeline } from '../api/gen/ForgePipeline';
import type { MrState } from '../api/gen/MrState';
import type { PipelineStatus } from '../api/gen/PipelineStatus';
import type { ReviewSummary } from '../api/gen/ReviewSummary';
import { mrName, mrRef, pipelineNoun } from './labels';

/** What an MR/PR's badge, hover card and view say (spec #4 §4 "4B"). Forge words come from
 * labels.ts; the rest is normalized. */
export const MR_STATE_WORDS: Record<MrState, string> = { open: 'open', draft: 'draft', merged: 'merged', closed: 'closed' };
export const MR_STATE_LABELS: Record<MrState, string> = { open: 'Open', draft: 'Draft', merged: 'Merged', closed: 'Closed' };
const PIPELINE_WORDS: Record<PipelineStatus, string> = { pending: 'pending', running: 'running', success: 'passed', failed: 'failed', canceled: 'canceled', skipped: 'skipped', manual: 'waiting for a manual job' };

/** "Merge request !12: open": the badge's accessible name. */
export const badgeLabel = (k: ForgeKind, n: number, state: MrState): string => `${mrName(k)} ${mrRef(k, n)}: ${MR_STATE_WORDS[state]}`;

export const pipelineText = (k: ForgeKind, p: ForgePipeline | null): string => (p ? `${pipelineNoun(k)} ${PIPELINE_WORDS[p.status]}` : `No ${pipelineNoun(k).toLowerCase()}`);

const names = (r: ReviewSummary, state: string): string => r.reviews.filter((x) => x.state === state).map((x) => x.user.name).join(', ');

export function reviewText(r: ReviewSummary): string {
  const count = r.approvalsRequired ? `${r.approvals} of ${r.approvalsRequired} approval${r.approvalsRequired === 1 ? '' : 's'}` : null;
  switch (r.decision) {
    case 'changesRequested': return `Changes requested by ${names(r, 'changesRequested') || 'a reviewer'}`;
    case 'approved': return count ?? `Approved by ${names(r, 'approved')}`;
    case 'reviewRequired': {
      if (count) return count;
      const pending = names(r, 'pending');
      return pending ? `Review requested from ${pending}` : 'Review required';
    }
    default: return r.approvals > 0 ? `Approved by ${names(r, 'approved')}` : 'No reviews yet';
  }
}

export const conflictText = (c: boolean | null): string => (c === null ? 'Checking for conflicts…' : c ? 'Has conflicts' : 'No conflicts');

/** A project path's owner: its namespace (`group/sub`), or a GitHub login. */
export const ownerOf = (path: string): string => path.split('/').slice(0, -1).join('/') || path;

/** `dev → main`; from a fork, `alice:fix → main`. */
export function branchesText(mr: ForgeMr): string {
  const [from, to] = branchesParts(mr);
  return `${from} → ${to}`;
}

/** The two sides of `branchesText`, for a view that draws the arrow itself. */
export function branchesParts(mr: ForgeMr): [string, string] {
  const fork = mr.sourceProject !== '' && mr.sourceProject !== mr.targetProject;
  return [`${fork ? `${ownerOf(mr.sourceProject)}:` : ''}${mr.sourceBranch}`, mr.targetBranch];
}

/** A pipeline's one-word state for the header's fact tile: "Passed", "Failed", "None". */
export const pipelineWord = (p: ForgePipeline | null): string => (p ? PIPELINE_WORDS[p.status].replace(/^./, (c) => c.toUpperCase()) : 'None');
