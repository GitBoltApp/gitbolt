import { useEffect, useRef, useState } from 'react';
import { escOwners } from '../../app/modalKeys';
import { labelListLimit, labelsSource, mapSource } from '../pickerCache';
import { api } from '../../api/client';
import type { ForgeMr } from '../../api/gen/ForgeMr';
import type { ForgeMrDetail } from '../../api/gen/ForgeMrDetail';
import type { MrEdit } from '../../api/gen/MrEdit';
import { useRuntime } from '../../app/runtime';
import { MarkdownField } from '../../markdown/MarkdownField';
import { MrPeople } from './MrPeople';
import { mrRef } from '../labels';
import { useTabForgeField } from '../mrStore';
import { putDescription, putMr, forgeWrite } from './writes';

/** Title, description, then Reviewers, Assignees and Labels in the people card's rows layout.
 * Title, description and labels are sent on Save (only what changed); reviewers and assignees
 * change at once, as in the view's cards (`MrPeople`). Opens with the title focused, or the Labels
 * picker open (`focus`). Esc leaves, as Cancel. */
export function EditMr({ tabId, mr, detail, onDone, focus = 'title' }: { tabId: string; mr: ForgeMr; detail: ForgeMrDetail | null; onDone: () => void; focus?: 'title' | 'labels' }) {
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    const f = form.current;
    if (!f) return;
    if (focus === 'labels') {
      const add = f.querySelector<HTMLButtonElement>('button[aria-label="Add label"]');
      if (add) { add.focus({ preventScroll: true }); add.click(); return; }
    }
    f.querySelector<HTMLInputElement>('input.mr-edit-title')?.focus({ preventScroll: true });
  }, [focus]);
  // Esc inside the form leaves Edit. An Esc owner, not a key handler: the flyout's own Esc (which
  // closes it) asks the owners first, and the form's emoji list, registered before this, goes first.
  useEffect(() => {
    const own = (e: KeyboardEvent) => {
      const t = e.target instanceof Element ? e.target : null;
      if (!t || !form.current?.contains(t)) return false;
      onDone();
      return true;
    };
    escOwners.add(own);
    return () => { escOwners.delete(own); };
  });
  const [title, setTitle] = useState(mr.title);
  const [description, setDescription] = useState(detail?.description ?? '');
  const [labels, setLabels] = useState<string[]>(mr.labels);
  const [colors, setColors] = useState<Record<string, string | null>>({});
  const [busy, setBusy] = useState(false);
  const kind = useTabForgeField(tabId, 'kind');
  const remote = useTabForgeField(tabId, 'remote');
  const repoId = useRuntime((s) => s.tabs[tabId]?.repo?.id);
  const parsed = labels;
  const edit: MrEdit = {
    title: title.trim() !== mr.title ? title.trim() : null,
    description: detail && description !== detail.description ? description : null,
    labels: parsed.join('\n') !== mr.labels.join('\n') ? parsed : null,
  };
  const changed = edit.title !== null || edit.description !== null || edit.labels !== null;
  const save = async () => {
    setBusy(true);
    const out = await forgeWrite(tabId, `Couldn't edit ${mrRef(kind ?? 'gitlab', mr.number)}`, (repo) => api.forgeEditMr(repo, mr.number, edit));
    setBusy(false);
    if (!out) return;
    putMr(tabId, out.value);
    if (edit.description !== null) putDescription(tabId, mr.number, edit.description);
    onDone();
  };
  return (
    <form ref={form} className="mr-edit" aria-label="Edit" onSubmit={(e) => { e.preventDefault(); if (changed && title.trim() && !busy) void save(); }}>
      <label className="mr-edit-field"><span>Title</span><input className="mr-edit-title" aria-label="Title" value={title} onChange={(e) => setTitle(e.target.value)} /></label>
      {/* --- 5A T9: Write / Preview --- */}
      <div className="mr-edit-field"><span>Description</span><MarkdownField label="Description" rows={10} value={description} disabled={!detail} onChange={setDescription} flavor={kind ?? 'gitlab'} context={{ kind: 'forge', tabId }} /></div>
      {/* --- end 5A T9 --- */}
      <MrPeople
        tabId={tabId}
        kind={kind ?? 'gitlab'}
        mr={mr}
        detail={detail}
        layout="rows"
        disabled={busy}
        labelsRow={{
          label: 'Labels', noun: 'label', chips: labels.map((l) => ({ key: l, label: l, color: colors[l] ?? (Object.hasOwn(mr.labelColors, l) ? mr.labelColors[l] : null) })),
          edit: repoId !== undefined && remote ? {
            ...mapSource(labelsSource(repoId, remote, labelListLimit(kind), (q) => api.forgeLabels(repoId, remote, q)), (l) => ({
              key: l.name, label: l.name, color: l.color,
              value: () => { setColors((c) => ({ ...c, [l.name]: l.color })); setLabels((cur) => (cur.includes(l.name) ? cur : [...cur, l.name])); },
            })),
            onRemove: (k) => setLabels((ls) => ls.filter((l) => l !== k)),
          } : undefined,
        }}
      />
      <div className="mr-form-row mr-edit-actions">
        <button type="button" className="mr-button" onClick={onDone}>Cancel</button>
        <button type="submit" className="mr-button primary" disabled={!changed || !title.trim() || busy}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </form>
  );
}
