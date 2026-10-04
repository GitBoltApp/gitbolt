import { api, errorMessage } from '../api/client';
import type { ForgeKind } from '../api/gen/ForgeKind';
import { useRuntime } from '../app/runtime';
import type { Section, SideItem } from '../sidebar/model';
import { mrRef, mrSectionLabel } from './labels';
import { forgeOf, patchForge, type TabForge } from './mrStore';

type SectionView = Pick<TabForge, 'kind' | 'list' | 'filter' | 'error'>;

function emptyText(kind: ForgeKind, v: SectionView): string {
  if (!v.list) return v.error ? `Couldn't load: ${v.error}` : 'Loading…';
  if (v.filter === 'mine') return 'None of yours are open';
  if (v.filter === 'reviewRequested') return 'No reviews requested from you';
  return `No open ${mrSectionLabel(kind).toLowerCase()}`;
}

/** The sidebar's "Merge requests" / "Pull requests" panel (spec #4 §2 "MR/PR list"): the
 * repository's open ones for the filter, newest activity first. Only with a forge target. */
export function mrSection(v: SectionView): Section | null {
  const kind = v.kind;
  if (!kind) return null;
  const items: SideItem[] = (v.list?.mrs ?? []).map((mr) => ({ key: `mr:${mr.number}`, kind: 'mr', name: `${mrRef(kind, mr.number)} ${mr.title}`, target: mr.headSha, time: mr.updatedAt, mr, forge: kind }));
  return { id: 'mrs', kind: 'mrs', label: mrSectionLabel(kind), nests: false, items, empty: emptyText(kind, v) };
}

/** The panels with the MR/PR section right after Remote. */
export function withMrSection(sections: Section[], mrs: Section | null): Section[] {
  if (!mrs) return sections;
  const i = sections.findIndex((s) => s.id === 'remote');
  return [...sections.slice(0, i + 1), mrs, ...sections.slice(i + 1)];
}

/** The list for the filter chosen now (a filter change; the poller keeps it fresh after). An
 * answer for a filter that's no longer chosen is dropped. */
export async function refreshMrList(tabId: string): Promise<void> {
  const repo = useRuntime.getState().tabs[tabId]?.repo?.id;
  const { kind, filter } = forgeOf(tabId);
  if (repo === undefined || !kind) return;
  try {
    const list = await api.forgeMrList(repo, filter);
    if (forgeOf(tabId).filter === list.filter) patchForge(tabId, { list });
  } catch (e) {
    patchForge(tabId, { error: errorMessage(e) });
  }
}
