import { useEffect } from 'react';
import { create } from 'zustand';
import { api } from '../api/client';
import type { PeopleLimits } from '../api/gen/PeopleLimits';
import { onForgeAccountsChanged } from './accountsBus';

export type PeopleRole = 'reviewers' | 'assignees';

/**
 * How many reviewers and assignees a project's MRs/PRs may have (`forgePeopleLimits`: GitLab
 * Free's one of each, GitHub's 10 assignees), by repository and remote. The core keeps them a
 * day across restarts; this asks once per session, and learns a limit a write ran into
 * (`learnLimit`). Unknown (loading, or failed): no limit.
 */
const useLimits = create<{ byKey: Record<string, PeopleLimits> }>(() => ({ byKey: {} }));
const asked = new Set<string>();
const keyOf = (repo: number, remote: string) => `${repo}\u0000${remote}`;

onForgeAccountsChanged(() => { asked.clear(); useLimits.setState({ byKey: {} }); });

export function usePeopleLimits(repo: number | undefined, remote: string | null | undefined): PeopleLimits | null {
  const key = repo !== undefined && remote ? keyOf(repo, remote) : null;
  const limits = useLimits((s) => (key ? s.byKey[key] ?? null : null));
  useEffect(() => {
    if (repo === undefined || !remote || !key || asked.has(key)) return;
    asked.add(key);
    api.forgePeopleLimits(repo, remote).then(
      // A limit learned meanwhile stays.
      (l) => useLimits.setState((s) => {
        const cur = s.byKey[key];
        return { byKey: { ...s.byKey, [key]: { maxReviewers: cur?.maxReviewers ?? l.maxReviewers, maxAssignees: cur?.maxAssignees ?? l.maxAssignees } } };
      }),
      () => asked.delete(key),
    );
  }, [repo, remote, key]);
  return limits;
}

/** A write the forge trimmed to one person (`ErrorDetail.peopleLimit`): one from now on. */
export function learnLimit(repo: number, remote: string, role: PeopleRole): void {
  const key = keyOf(repo, remote);
  useLimits.setState((s) => {
    const cur = s.byKey[key] ?? { maxReviewers: null, maxAssignees: null };
    return { byKey: { ...s.byKey, [key]: role === 'reviewers' ? { ...cur, maxReviewers: 1 } : { ...cur, maxAssignees: 1 } } };
  });
}

/** `limits`' cap for `role`; null: none. */
export const maxOf = (limits: PeopleLimits | null, role: PeopleRole): number | null =>
  (role === 'reviewers' ? limits?.maxReviewers : limits?.maxAssignees) ?? null;

/** The + button's tooltip at the cap. */
export function limitTip(kind: string | null | undefined, role: PeopleRole, max: number): string {
  const noun = role === 'reviewers' ? 'reviewer' : 'assignee';
  if (max === 1) return `This project allows one ${noun}`;
  return `${kind === 'github' ? 'GitHub' : 'This project'} allows up to ${max} ${noun}s`;
}

/** Tests only. */
export function resetPeopleLimits(): void {
  asked.clear();
  useLimits.setState({ byKey: {} });
}
