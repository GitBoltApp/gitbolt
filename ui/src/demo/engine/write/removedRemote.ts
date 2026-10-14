// A removed remote's undo and redo: the core's write/remotes.rs `check_removed_remote` (the refusals)
// and `replay_symrefs` (its symbolic refs, which the entry's ref moves can't carry).
import { gbError } from '../errors';
import { readLocalConfig, type ConfigChange } from './config';
import type { RemovedRemote } from './journal';
import { deleteRefFiles } from './refs';
import type { DemoRepo } from '../repo';

/** A `remote.<name>.<var>` key of exactly this remote (not of `<name>.x`), the name case-sensitive. */
export function isRemoteKey(key: string, name: string): boolean {
  const prefix = `remote.${name}.`;
  return key.startsWith(prefix) && key.length > prefix.length && !key.slice(prefix.length).includes('.');
}

/** Undo needs the name free (a remote added since would get this one's settings mixed in), redo needs
 *  the remote still there; every recorded key must still hold what the removal (or its undo) left. */
export function checkRemovedRemote(demo: DemoRepo, removed: RemovedRemote, config: ConfigChange[], undo: boolean): void {
  const now = readLocalConfig(demo);
  const exists = now.some(([k]) => isRemoteKey(k, removed.name));
  // A stale remote's removal recorded no `remote.<name>.*` key: redo has no config to look for.
  const stale = !config.some((c) => isRemoteKey(c.key, removed.name));
  if (undo && exists) throw gbError('InvalidInput', `A remote named ${removed.name} exists again; remove it to undo`);
  if (!undo && !exists && !stale) throw gbError('InvalidInput', `The remote ${removed.name} is gone already`);
  for (const c of config) {
    const values = now.filter(([k]) => k === c.key).map(([, v]) => v);
    const left = undo ? c.new : c.old;
    if (JSON.stringify(values) !== JSON.stringify(left)) throw gbError('InvalidInput', `${c.key} changed since the remote was ${undo ? 'removed' : 'restored'}`);
  }
}

/** Undo creates each symbolic ref only where nothing is now; redo deletes each one still pointing where it did. */
export function replaySymrefs(demo: DemoRepo, removed: RemovedRemote, undo: boolean): boolean {
  const refs = demo.refMap();
  let touched = false;
  for (const [name, target] of removed.symrefs) {
    if (undo) {
      if (refs.has(name)) continue;
      const p = `${demo.gitdir}/${name}`;
      demo.fs.mkdirpSync(p.slice(0, p.lastIndexOf('/')));
      demo.fs.writeFileSync(p, `ref: ${target}\n`);
    } else if (refs.get(name)?.symref === target) deleteRefFiles(demo, name);
    touched = true;
  }
  return touched;
}
