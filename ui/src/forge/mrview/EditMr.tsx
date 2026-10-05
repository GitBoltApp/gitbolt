import { useState } from 'react';
import { api } from '../../api/client';
import type { ForgeLabel } from '../../api/gen/ForgeLabel';
import type { ForgeMr } from '../../api/gen/ForgeMr';
import type { ForgeMrDetail } from '../../api/gen/ForgeMrDetail';
import type { MrEdit } from '../../api/gen/MrEdit';
import { useRuntime } from '../../app/runtime';
import { SearchPicker } from '../create/SearchPicker';
import { mrRef } from '../labels';
import { useTabForgeField } from '../mrStore';
import { putDescription, putMr, forgeWrite } from './writes';

/** Title, description and labels (picked from the project's own labels). Only what changed is sent. */
export function EditMr({ tabId, mr, detail, onDone }: { tabId: string; mr: ForgeMr; detail: ForgeMrDetail | null; onDone: () => void }) {
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
    <form className="mr-edit" aria-label="Edit" onSubmit={(e) => { e.preventDefault(); if (changed && title.trim() && !busy) void save(); }}>
      <label>Title<input aria-label="Title" value={title} onChange={(e) => setTitle(e.target.value)} /></label>
      <label>Description<textarea aria-label="Description" rows={10} value={description} disabled={!detail} onChange={(e) => setDescription(e.target.value)} /></label>
      {repoId !== undefined && remote ? (
        <SearchPicker<ForgeLabel>
          label="Labels"
          chips={labels.map((l) => ({ key: l, label: l, color: colors[l] ?? null }))}
          onRemove={(k) => setLabels((ls) => ls.filter((l) => l !== k))}
          search={(q) => api.forgeLabels(repoId, remote, q).then((ls) => ls.map((l) => ({ key: l.name, label: l.name, color: l.color, value: l })))}
          onPick={(l) => { setColors((c) => ({ ...c, [l.name]: l.color })); setLabels((ls) => (ls.includes(l.name) ? ls : [...ls, l.name])); }}
        />
      ) : null}
      <div className="mr-form-row">
        <button type="button" className="mr-button" onClick={onDone}>Cancel</button>
        <button type="submit" className="mr-button primary" disabled={!changed || !title.trim() || busy}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </form>
  );
}
