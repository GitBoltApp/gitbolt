import { FilePlus } from 'lucide-react';
import { activeStore, activeTab, registerActions } from '../app/actions';
import { CREATE_FILE, createFileFromPalette } from './createFile';

/** UX round 3 O.1: Create file… in the palette (and the hamburger's Repository menu). In a tab
 * with no working tree it says why instead (a toast). */
const offActions = registerActions([{
  id: 'file.create', label: CREATE_FILE, group: 'Repository', icon: FilePlus, tooltip: 'Create a new, empty file in the working tree (you can undo this)',
  when: () => activeTab()?.kind === 'repo' && activeStore() !== null,
  run: () => createFileFromPalette(activeStore()),
}]);
import.meta.hot?.dispose(offActions);
