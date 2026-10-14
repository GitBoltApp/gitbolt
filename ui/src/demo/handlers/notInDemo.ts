// The methods a browser can't run (spec §4.3): each says what the visitor tried, and changes
// nothing.
import type { NotInDemoMethod } from '../coverage';
import { notInDemo } from '../engine/errors';

const WHAT: Record<NotInDemoMethod, string> = {
  logsDir: 'log files',
  openLogsFolder: 'log files',
  forgeOpenVideo: 'opening videos in another app',
  openUrl: 'opening links',
  openIn: 'opening files in other apps',
  createProfile: 'profiles',
  switchProfile: 'profiles',
  deleteProfile: 'profiles',
  authAnswer: 'credentials',
  submoduleUpdate: 'updating submodules',
  submoduleSync: 'syncing submodules',
  clone: 'cloning',
  pickFolder: 'folders on your disk',
  testWrite: 'test writes',
  removeIndexLock: 'index locks',
  lfsFetch: 'Git LFS downloads',
  lfsPull: 'Git LFS downloads',
  lfsDownload: 'Git LFS downloads',
  lfsTrack: 'Git LFS tracking',
  lfsUntrack: 'Git LFS tracking',
  addForgeAccount: 'forge accounts',
  removeForgeAccount: 'forge accounts',
  forgeTokenPage: 'forge accounts',
  updateDownload: 'updates',
  updateInstall: 'updates',
  updateRestart: 'updates',
  updateRemoveLegacyBundle: 'updates',
};

export const notInDemoHandlers = Object.fromEntries(
  (Object.keys(WHAT) as NotInDemoMethod[]).map((m) => [m, async () => notInDemo(WHAT[m])]),
) as Record<NotInDemoMethod, () => Promise<never>>;
