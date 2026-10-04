import { useState } from 'react';
import { api } from '../../api/client';
import type { ForgeMr } from '../../api/gen/ForgeMr';
import type { ForgeMrDetail } from '../../api/gen/ForgeMrDetail';
import type { MrEdit } from '../../api/gen/MrEdit';
import { putDescription, putMr, forgeWrite } from './writes';

/** Title, description and labels (a comma-separated list: ruling 13). Only what changed is sent. */
export function EditMr({ tabId, mr, detail, onDone }: { tabId: string; mr: ForgeMr; detail: ForgeMrDetail | null; onDone: () => void }) {
  const [title, setTitle] = useState(mr.title);
  const [description, setDescription] = useState(detail?.description ?? '');
  const [labels, setLabels] = useState(mr.labels.join(', '));
  const [busy, setBusy] = useState(false);
  const parsed = labels.split(',').map((l) => l.trim()).filter(Boolean);
  const edit: MrEdit = {
    title: title.trim() !== mr.title ? title.trim() : null,
    description: detail && description !== detail.description ? description : null,
    labels: parsed.join('\n') !== mr.labels.join('\n') ? parsed : null,
  };
  const changed = edit.title !== null || edit.description !== null || edit.labels !== null;
  const save = async () => {
    setBusy(true);
    const out = await forgeWrite(tabId, "Couldn't save the changes", (repo) => api.forgeEditMr(repo, mr.number, edit));
    setBusy(false);
    if (!out) return;
    putMr(tabId, out.value);
    if (edit.description !== null) putDescription(tabId, mr.number, edit.description);
    onDone();
  };
  return (
    <form className="mr-edit" aria-label="Edit" onSubmit={(e) => { e.preventDefault(); if (changed && title.trim() && !busy) void save(); }}>
      <label>Title<input aria-label="Title" value={title} onChange={(e) => setTitle(e.target.value)} /></label>
      <label>Description<textarea aria-label="Description" value={description} disabled={!detail} onChange={(e) => setDescription(e.target.value)} /></label>
      <label>Labels<input aria-label="Labels" placeholder="Comma-separated" value={labels} onChange={(e) => setLabels(e.target.value)} /></label>
      <div className="mr-form-row">
        <button type="button" className="mr-button" onClick={onDone}>Cancel</button>
        <button type="submit" className="mr-button primary" disabled={!changed || !title.trim() || busy}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </form>
  );
}
