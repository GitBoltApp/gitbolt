import { List, ListTree } from 'lucide-react';
import { HoverTooltip } from '../ui/HoverTooltip';
import { useFileListPrefs } from './fileListPrefs';

/** Path/Tree, the file lists' one persisted view mode (`gitvolt.fileList.v1`): in a list's own
 * toolbar, or (WIP, K36) once for both of its lists. */
export function PathTreeToggle() {
  const mode = useFileListPrefs((s) => s.mode);
  const set = useFileListPrefs((s) => s.set);
  return (
    <div className="segmented">
      <HoverTooltip content="Files by path"><button type="button" aria-pressed={mode === 'path'} onClick={() => set({ mode: 'path' })}><List size={12} aria-hidden /><span className="tb-label">Path</span></button></HoverTooltip>
      <HoverTooltip content="Files in a folder tree"><button type="button" aria-pressed={mode === 'tree'} onClick={() => set({ mode: 'tree' })}><ListTree size={12} aria-hidden /><span className="tb-label">Tree</span></button></HoverTooltip>
    </div>
  );
}
