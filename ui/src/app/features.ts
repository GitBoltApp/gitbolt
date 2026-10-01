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
import '../statusbar/feature';
import '../auth/feature';
import '../tabs/features';
import '../sidebar/actions';
import '../find/actions';
import '../open/feature';
import '../settings/feature';
import '../palette/feature';
