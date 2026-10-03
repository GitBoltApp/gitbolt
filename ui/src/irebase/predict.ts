import { useEffect, useMemo } from 'react';
import { api } from '../api/client';
import type { Prediction } from '../api/gen/Prediction';
import type { RebaseRow } from '../api/gen/RebaseRow';
import { predictionKey, toRequest } from './model';
import { editSession, sessionOf, useRebaseSessions, type PredictionView } from './session';

export function predictionView(p: Prediction): PredictionView {
  if (p.off) return { status: 'off', byRow: {}, first: null, note: p.off };
  const byRow: Record<string, string[]> = {};
  for (const r of p.rows) if (r.conflicts.length) byRow[r.oid] = r.conflicts;
  return { status: 'ready', byRow, first: p.rows.find((r) => r.conflicts.length)?.oid ?? null, note: null };
}

/** Debounced (`delay` after the last change) and cancellable: only the newest answer counts. The
 * core stops a superseded run itself, at its next row (plan 3C T7). */
export function createPredictor(send: (rows: RebaseRow[]) => Promise<Prediction>, onResult: (v: PredictionView) => void, delay = 250) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let seq = 0;
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return {
    schedule(rows: RebaseRow[]) {
      clear();
      const mine = ++seq;
      timer = setTimeout(() => {
        timer = null;
        send(rows).then(
          (p) => { if (mine === seq) onResult(predictionView(p)); },
          () => { if (mine === seq) onResult({ status: 'failed', byRow: {}, first: null, note: "Couldn't predict conflicts" }); },
        );
      }, delay);
    },
    cancel() {
      seq++;
      clear();
    },
  };
}

/** Predicts the open plan after every change that matters (order, drops, folds). A pending
 * prediction keeps the previous ⚠ marks (no flicker). */
export function usePrediction(tabId: string): void {
  // The base too: a Reload after the base moved has the same rows, and the old base's ⚠ marks are stale.
  const key = useRebaseSessions((x) => { const s = x.sessions[tabId]; return s ? `${s.state.base.oid}|${predictionKey(s.state)}` : null; });
  const predictor = useMemo(() => createPredictor(
    (rows) => { const s = sessionOf(tabId)!; return api.predictRebase(s.ctx.repoId, s.ctx.worktree, s.state.base.oid, rows); },
    (v) => editSession(tabId, (s) => ({ ...s, prediction: v })),
  ), [tabId]);
  useEffect(() => {
    const s = sessionOf(tabId);
    if (key === null || !s) return;
    editSession(tabId, (x) => ({ ...x, prediction: { ...x.prediction, status: 'pending' } }));
    predictor.schedule(toRequest(s.state).rows);
  }, [key, predictor, tabId]);
  useEffect(() => () => predictor.cancel(), [predictor]);
}
