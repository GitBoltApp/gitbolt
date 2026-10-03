import { fileTargetOf } from '../menu/menuEnv';
import { parseListSpec } from '../openIn/openers';
import type { DiffTarget, RepoViewState } from '../repo/store';
import type { HistoryStart } from './open';
import { historyStart } from './sources';

/** Where the open diff's file history starts (the toolbar's Blame | History, the palette). */
export function historyStartOf(s: RepoViewState, target: DiffTarget): HistoryStart | null {
  const spec = parseListSpec(target.key);
  return spec ? historyStart(fileTargetOf(s, spec, target, target.status !== '')) : null;
}
