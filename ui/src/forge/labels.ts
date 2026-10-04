import type { ForgeKind } from '../api/gen/ForgeKind';

/** The only forge-specific words the UI uses (spec #4 §3.1): everything else is normalized. */
export const forgeName = (k: ForgeKind): 'GitLab' | 'GitHub' => (k === 'gitlab' ? 'GitLab' : 'GitHub');
export const mrNoun = (k: ForgeKind): 'MR' | 'PR' => (k === 'gitlab' ? 'MR' : 'PR');
export const mrRef = (k: ForgeKind, n: number): string => `${k === 'gitlab' ? '!' : '#'}${n}`;
export const mrSectionLabel = (k: ForgeKind): 'Merge requests' | 'Pull requests' => (k === 'gitlab' ? 'Merge requests' : 'Pull requests');

// --- 4B T8 ---
export const mrName = (k: ForgeKind): 'Merge request' | 'Pull request' => (k === 'gitlab' ? 'Merge request' : 'Pull request');
export const pipelineNoun = (k: ForgeKind): 'Pipeline' | 'Checks' => (k === 'gitlab' ? 'Pipeline' : 'Checks');
// --- end 4B T8 ---

// --- 4C T6 ---
export const mrLongNoun = (k: ForgeKind): 'merge request' | 'pull request' => (k === 'gitlab' ? 'merge request' : 'pull request');
// --- end 4C T6 ---
