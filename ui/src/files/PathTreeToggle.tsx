import { List, ListTree } from 'lucide-react';
import { useFileListPrefs } from './fileListPrefs';

/** Path/Tree, the file lists' one persisted view mode (`gitbolt.fileList.v1`): in a list's own
 * toolbar, or (WIP, K36) once for both of its lists. */
export function PathTreeToggle() {
  const mode = useFileListPrefs((s) => s.mode);
  const set = useFileListPrefs((s) => s.set);
  return (
    <div className="segmented">
      <button type="button" aria-pressed={mode === 'path'} onClick={() => set({ mode: 'path' })}><List size={12} aria-hidden />Path</button>
      <button type="button" aria-pressed={mode === 'tree'} onClick={() => set({ mode: 'tree' })}><ListTree size={12} aria-hidden />Tree</button>
    </div>
  );
}
