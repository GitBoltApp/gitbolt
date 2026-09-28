import type { RemoteRefLabel } from '../api/gen/RemoteRefLabel';

/** `origin/foo` for `refs/remotes/origin/foo`: exact (it keeps an upstream's own branch name).
 * What the UI shows for a remote ref: never the `refs/remotes/` prefix (F9). */
export const remoteShort = (r: RemoteRefLabel) => r.fullName.replace(/^refs\/remotes\//, '');
