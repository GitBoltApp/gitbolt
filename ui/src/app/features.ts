/**
 * Every shell feature, imported once for its registrations (actions, slots, menus): each feature
 * module registers what it contributes (`registerActions`, `registerAppSlot` /
 * `registerTabSlot`, `registerMenu`) at import time, so features never edit each other's files
 * (ruling R10). Add one line per feature module, in the order its slot entries should appear
 * when they share an `order`. Each module releases its registrations on a hot update
 * (`import.meta.hot?.dispose(off)`), or the re-run registration throws "already registered".
 */
import './coreActions';
import '../toolbar/feature';
import '../undo/feature';
import '../stage/feature';
import '../banner/feature';
import '../statusbar/feature';
import '../debug/feature';
import '../auth/feature';
import '../tabs/features';
import '../sidebar/actions';
import '../find/actions';
import '../open/feature';
import '../settings/feature';
import '../theme/feature';
import '../palette/feature';
import '../worktrees/feature';
// --- 2C T11 ---
import '../branches/feature';
// --- end 2C T11 ---
// --- 2C T13 ---
import '../stash/feature';
// --- end 2C T13 ---
// --- 2D T15 ---
import '../conflicts/menus';
// --- end 2D T15 ---
// --- 2D T16 ---
import '../conflicts/feature';
// --- end 2D T16 ---
// --- 2D T17 ---
import '../sync/pushFeature';
// --- end 2D T17 ---
// --- 2D T18 ---
import '../integrate/feature';
// --- end 2D T18 ---
// --- 2D T19 ---
import '../sync/pullFeature';
// --- end 2D T19 ---
// --- 2C T12 ---
import '../branches/checkoutMenus';
// --- end 2C T12 ---
// --- 3D T3 ---
import '../stacks/feature';
// --- end 3D T3 ---
// --- 3B T7 ---
import '../tags/feature';
// --- end 3B T7 ---
// --- 3A T4 ---
import '../history/feature';
// --- end 3A T4 ---
// --- 3C ---
import '../irebase/feature';
// --- end 3C ---
// --- 3B T6 ---
import '../pick/feature';
// --- end 3B T6 ---
// --- UX round 3 O.1 ---
import '../files/createFileFeature';
// --- end UX round 3 O.1 ---
// --- UX round 5 X ---
import '../shortcuts/feature';
// --- end UX round 5 X ---
// --- 4B T6 ---
import '../ui/flyout/feature';
// --- end 4B T6 ---
// --- 4A T12 ---
import '../remotes/feature';
// --- end 4A T12 ---
// --- 4B T12 ---
import '../forge/mrview/feature';
// --- end 4B T12 ---
// --- 4B T15 ---
import '../forge/entryPoints';
// --- end 4B T15 ---
