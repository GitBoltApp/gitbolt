import { useMemo } from 'react';
import { useRepoContext } from '../app/repoContext';
import { useDiffPrefs } from '../diff/diffPrefs';
import { useRepoViewStore, type DiffTarget } from '../repo/store';
import { HoverTooltip } from '../ui/HoverTooltip';
import { historyStartOf } from './fromDiff';
import { openFileHistory } from './open';

const NO_HISTORY = 'No history yet: the file is new';
export const NO_BINARY_BLAME = "Blame isn't available for binary files";

/** The diff toolbar's `[Blame | History]` (spec #3 §4.2; the slot #1 reserved), for the open
 * file. A file with no history (new in the working tree) keeps the group, disabled, so the
 * toolbar's geometry never changes between files. `aria-disabled`, not `disabled`: the tooltip
 * still shows on hover. `binary`: the open file is one (hex or an image), which has no lines to
 * blame: Blame is off, History stays. */
export function HistoryButtons({ target, binary = false }: { target: DiffTarget; binary?: boolean }) {
  const store = useRepoViewStore();
  const { tabId } = useRepoContext();
  // Read once per target: the selection that made it doesn't change under an open file.
  const start = useMemo(() => historyStartOf(store.getState(), target), [store, target]);
  const off = start === null || undefined;
  // From Diff View, File History opens on each version's Changes; from File View, on the File.
  const open = (blame: boolean) => () => {
    if (!start || (blame && binary)) return;
    useDiffPrefs.getState().set({ historyView: target.view === 'diff' ? 'changes' : 'file' });
    openFileHistory(tabId, start, blame);
  };
  return (
    <div className="segmented" role="group" aria-label="History">
      <HoverTooltip content={!start ? NO_HISTORY : binary ? NO_BINARY_BLAME : `Show who last changed each line of ${start.path}`}>
        <button type="button" aria-disabled={off || binary || undefined} onClick={open(true)}>Blame</button>
      </HoverTooltip>
      <HoverTooltip content={start ? `Show the commits that changed ${start.path}` : NO_HISTORY}>
        <button type="button" aria-disabled={off} onClick={open(false)}>History</button>
      </HoverTooltip>
    </div>
  );
}
