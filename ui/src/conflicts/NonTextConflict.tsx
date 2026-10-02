import { useState } from 'react';
import type { ConflictFilePayload } from '../api/gen/ConflictFilePayload';
import type { Resolution } from '../api/gen/Resolution';
import type { WriteCtx } from '../write/client';
import { resolveFile } from './resolve';

const SAID: Record<ConflictFilePayload['kind'], (c: string, i: string) => string> = {
  bothModified: (c, i) => `Changed in both ${c} and ${i} (not text)`,
  bothAdded: (c, i) => `Added in both ${c} and ${i}`,
  deletedByUs: (c, i) => `Deleted in ${c}, modified in ${i}`,
  deletedByThem: (c, i) => `Modified in ${c}, deleted in ${i}`,
  addedByUs: (c) => `Added in ${c} only`,
  addedByThem: (_, i) => `Added in ${i} only`,
  bothDeleted: (c, i) => `Deleted in both ${c} and ${i}`,
};

/**
 * Binary, delete/modify, add/add binary, mode and submodule conflicts (§13.3): buttons, never an
 * editor. Each sends `conflictFile`'s `base` too (the file as it was read). One send at a time
 * (the buttons are disabled meanwhile). A Stale answer (resolved elsewhere since) goes to
 * `onStale`, which re-reads the conflict, rather than to a Retry that can't work.
 */
export function NonTextConflict({ ctx, file, onResolved, onStale }: { ctx: WriteCtx; file: ConflictFilePayload; onResolved?: () => void; onStale?: (message: string) => void }) {
  const { current, incoming } = file.labels;
  const [busy, setBusy] = useState(false);
  const send = (r: Resolution) => async () => {
    if (busy) return;
    setBusy(true);
    try {
      const done = await resolveFile(ctx, file.path, r, file.base ?? undefined, onStale ? (err) => {
        if (err.kind !== 'Stale') return false;
        onStale(err.message);
        return true;
      } : undefined);
      if (done) onResolved?.();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="merge-nontext" role="region" aria-label={`Conflict in ${file.path}`}>
      <p>{SAID[file.kind](current, incoming)}</p>
      <div className="merge-nontext-actions">
        <button type="button" disabled={busy} onClick={send({ kind: 'current' })}>Take current</button>
        <button type="button" disabled={busy} onClick={send({ kind: 'incoming' })}>Take incoming</button>
        <button type="button" disabled={busy} className="danger" onClick={send({ kind: 'delete' })}>Delete file</button>
      </div>
    </div>
  );
}
