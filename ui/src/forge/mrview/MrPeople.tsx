import { api } from '../../api/client';
import type { ForgeKind } from '../../api/gen/ForgeKind';
import type { ForgeMr } from '../../api/gen/ForgeMr';
import type { ForgeMrDetail } from '../../api/gen/ForgeMrDetail';
import type { ForgeUser } from '../../api/gen/ForgeUser';
import { useRuntime } from '../../app/runtime';
import { useTabForgeField } from '../mrStore';
import { limitTip, maxOf, usePeopleLimits, type PeopleRole } from '../peopleLimits';
import { mapSource, peopleSource } from '../pickerCache';
import { PeopleCard, type PeopleChip, type PeopleRow, type RowEdit } from '../ui/PeopleCard';
import { changeMrPeople } from './writes';

const userChip = (u: ForgeUser): PeopleChip => ({ key: String(u.id), label: u.name, user: u });

/**
 * The view's reviewers, assignees and labels. While the MR/PR is open, + Add and × change the
 * reviewers and assignees at once (Create's cached people search; no confirm), shown before the
 * forge answers and put back if it refuses. A project that allows one (GitLab Free) makes + a
 * swap: the pick replaces whoever is there; GitHub's 10 assignees disable + at the cap. Labels
 * change in Edit: the Labels card's pencil (`editLabels`) opens it.
 */
export function MrPeople({ tabId, kind, mr, detail, editLabels, layout = 'cards', labelsRow, disabled }: {
  tabId: string; kind: ForgeKind; mr: ForgeMr; detail: ForgeMrDetail | null; editLabels?: () => void;
  /** `rows`: Edit's one card, a row each. */
  layout?: 'cards' | 'rows';
  /** Replaces the Labels row (Edit's, with its own pending labels and picker). */
  labelsRow?: PeopleRow;
  disabled?: boolean;
}) {
  const remote = useTabForgeField(tabId, 'remote');
  const repoId = useRuntime((s) => s.tabs[tabId]?.repo?.id);
  const limits = usePeopleLimits(repoId, remote);
  const live = (mr.state === 'open' || mr.state === 'draft') && detail !== null && repoId !== undefined && !!remote;
  const editOf = (role: PeopleRole): RowEdit | undefined => {
    if (!live) return undefined;
    const list = detail[role];
    const max = maxOf(limits, role);
    return {
      ...mapSource(peopleSource(repoId, remote, (q) => api.forgeSearchUsers(repoId, remote, q)), (u: ForgeUser) => ({
        key: String(u.id), label: u.name, detail: `@${u.username}`,
        value: () => void changeMrPeople(tabId, kind, mr.number, role, max === 1 ? { add: u, replace: list } : { add: u }),
      })),
      onRemove: (key) => {
        const u = list.find((x) => String(x.id) === key);
        if (u) void changeMrPeople(tabId, kind, mr.number, role, { remove: u });
      },
      // GitHub keeps a submitted review: only a pending request can be withdrawn.
      canRemove: role === 'reviewers' && kind === 'github'
        ? (key) => !detail.mr.review.reviews.some((r) => String(r.user.id) === key && r.state !== 'pending')
        : undefined,
      max,
      maxTip: max !== null ? limitTip(kind, role, max) : undefined,
    };
  };
  const rows: PeopleRow[] = [
    { label: 'Reviewers', noun: 'reviewer', chips: detail ? detail.reviewers.map(userChip) : null, edit: editOf('reviewers') },
    { label: 'Assignees', noun: 'assignee', chips: detail ? detail.assignees.map(userChip) : null, edit: editOf('assignees') },
    labelsRow ?? {
      label: 'Labels', noun: 'label', chips: mr.labels.map((l) => ({ key: l, label: l, color: mr.labelColors && Object.hasOwn(mr.labelColors, l) ? mr.labelColors[l] : null })),
      pencil: editLabels && { tip: 'Edit labels', run: editLabels },
    },
  ];
  return <PeopleCard label="Reviewers, assignees and labels" rows={rows} layout={layout} disabled={disabled} />;
}
