import { registerKeyHints, type KeyHint } from './hints';

/**
 * Hints for the view-local keys: handlers in a component's own onKeyDown (they need focus in that
 * view), so no registry sees them. Each hint names its `source` file; `hints.test.ts` fails when a
 * file with a key handler is neither named here (or at a registration site) nor exempt there.
 */
const h = (id: string, section: string, label: string, keys: string[], source: string, context?: string): KeyHint => ({ id, section, label, keys, source, context });

registerKeyHints([
  // Graph (graph/GraphView.tsx)
  h('graph.move', 'Graph', 'Select previous / next commit', ['Up', 'Down'], 'graph/GraphView.tsx', '(when the graph has focus)'),
  h('graph.page', 'Graph', 'Page up / down', ['PageUp', 'PageDown'], 'graph/GraphView.tsx', '(when the graph has focus)'),
  h('graph.ends', 'Graph', 'First / last commit', ['Home', 'End'], 'graph/GraphView.tsx', '(when the graph has focus)'),
  h('graph.range', 'Graph', 'Extend the selection', ['Shift+Up', 'Shift+Down'], 'graph/GraphView.tsx', '(when the graph has focus)'),
  h('graph.open', 'Graph', 'Open the selected commit\'s first changed file', ['Right', 'Enter'], 'repo/RepoView.tsx', '(when the graph has focus)'),
  h('graph.menu', 'Graph', 'Context menu', ['Shift+F10', 'Menu'], 'graph/GraphView.tsx', '(when the graph has focus)'),
  h('graph.draft', 'Graph', 'Leave the WIP summary box', ['Esc', 'Enter'], 'graph/WipSummary.tsx', '(when in the WIP summary input)'),
  // File list (files/FileList.tsx)
  h('files.move', 'File list', 'Previous / next file', ['Up', 'Down'], 'files/FileList.tsx', '(when the file list has focus)'),
  h('files.page', 'File list', 'Page up / down', ['PageUp', 'PageDown'], 'files/FileList.tsx', '(when the file list has focus)'),
  h('files.ends', 'File list', 'First / last file', ['Home', 'End'], 'files/FileList.tsx', '(when the file list has focus)'),
  h('files.expand', 'File list', 'Expand folder, or open the file', ['Right'], 'files/FileList.tsx', '(when the file list has focus)'),
  h('files.collapse', 'File list', 'Collapse folder, or close the diff', ['Left'], 'files/FileList.tsx', '(when the file list has focus)'),
  h('files.toggle', 'File list', 'Open or close the file, toggle a folder', ['Enter', 'Space'], 'files/FileList.tsx', '(when the file list has focus)'),
  h('files.menu', 'File list', 'Context menu', ['Shift+F10', 'Menu'], 'files/FileList.tsx', '(when the file list has focus)'),
  h('files.filter', 'File list', 'Close the file filter', ['Esc'], 'details/WipSections.tsx', '(when in the filter input)'),
  h('files.filterLeave', 'File list', 'Clear the file filter', ['Esc'], 'files/FilesFilter.tsx', '(when in the filter input)'),
  h('files.create', 'File list', 'Create the file / cancel', ['Enter', 'Esc'], 'files/CreateFileInput.tsx', '(when naming a new file)'),
  // Staging undo (stage/feature.ts)
  h('stage.undo', 'Staging', 'Undo the last staging action', ['Mod+Z'], 'stage/feature.ts', '(when in the diff view or WIP file list)'),
  h('stage.redo', 'Staging', 'Redo the staging action', ['Mod+Shift+Z'], 'stage/feature.ts', '(when in the diff view or WIP file list)'),
  // Sidebar (sidebar/SidebarPanel.tsx, sidebar/Sidebar.tsx)
  h('sb.move', 'Sidebar', 'Previous / next row', ['Up', 'Down'], 'sidebar/SidebarPanel.tsx', '(when the sidebar has focus)'),
  h('sb.ends', 'Sidebar', 'First / last row', ['Home', 'End'], 'sidebar/SidebarPanel.tsx', '(when the sidebar has focus)'),
  h('sb.open', 'Sidebar', 'Activate the row', ['Enter', 'Space'], 'sidebar/SidebarPanel.tsx', '(when the sidebar has focus)'),
  h('sb.expand', 'Sidebar', 'Expand / collapse a group', ['Right', 'Left'], 'sidebar/SidebarPanel.tsx', '(when the sidebar has focus)'),
  h('sb.filter', 'Sidebar', 'Clear the filter / move into the list', ['Esc', 'Down'], 'sidebar/Sidebar.tsx', '(when in the sidebar filter)'),
  h('sb.resize', 'Sidebar', 'Reset the width', ['Enter'], 'sidebar/Sidebar.tsx', '(when the resize handle has focus)'),
  // Find (find/FindBox.tsx)
  h('find.next', 'Find', 'Next match', ['Enter', 'Down'], 'find/FindBox.tsx', '(when in the find box)'),
  h('find.prev', 'Find', 'Previous match', ['Shift+Enter', 'Up'], 'find/FindBox.tsx', '(when in the find box)'),
  h('find.close', 'Find', 'Close find', ['Esc'], 'find/FindBox.tsx', '(when in the find box)'),
  // Palette (palette/Palette.tsx)
  h('pal.move', 'Command palette', 'Previous / next result', ['Up', 'Down'], 'palette/Palette.tsx', '(when the palette is open)'),
  h('pal.run', 'Command palette', 'Run the result', ['Enter'], 'palette/Palette.tsx', '(when the palette is open)'),
  h('pal.close', 'Command palette', 'Close', ['Esc'], 'app/modalKeys.ts', '(when the palette is open)'),
  // Merge tool (conflicts/MergeTool.tsx)
  h('merge.step', 'Merge tool', 'Next / previous conflict', ['F7', 'Shift+F7'], 'conflicts/MergeTool.tsx'),
  h('merge.save', 'Merge tool', 'Save the result', ['Mod+S'], 'conflicts/MergeTool.tsx'),
  h('merge.toggle', 'Merge tool', 'Toggle the conflict at the cursor', ['Space'], 'conflicts/MergeTool.tsx', '(when the cursor is in a conflict)'),
  // Tabs (tabs/TabBar.tsx)
  h('tabs.rename', 'Navigation', 'Commit / cancel a tab rename', ['Enter', 'Esc'], 'tabs/TabBar.tsx', '(when renaming a tab)'),
  h('tabs.activate', 'Navigation', 'Activate the focused tab', ['Enter', 'Space'], 'tabs/TabBar.tsx', '(when a tab has focus)'),
  // Dialogs and menus (app/modalKeys.ts, menu/ContextMenu.tsx, ui/Select.tsx)
  h('dlg.close', 'Dialogs and menus', 'Close the dialog / menu', ['Esc'], 'app/modalKeys.ts'),
  h('menu.move', 'Dialogs and menus', 'Move in a menu', ['Up', 'Down', 'Left', 'Right', 'Home', 'End', 'Enter'], 'menu/ContextMenu.tsx', '(when a menu is open)'),
  // Image diff (image/ImageDiff.tsx)
  h('img.swipe', 'Diff', 'Move the swipe handle', ['Left', 'Right'], 'image/ImageDiff.tsx', '(when the swipe handle has focus)'),
  h('diff.save', 'Diff', 'Save the working copy', ['Mod+S'], 'diff/DiffPanel.tsx', '(when editing a file)'),
]);
