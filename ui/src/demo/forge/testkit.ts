// Test-only: forge_lab's forge.json (Task 18) as a literal, so forge unit tests need no harness;
// and a test repository whose origin is the lab's project, with the page's forge on it.
import * as git from 'isomorphic-git';
import type { AppEvent } from '../../api/gen/AppEvent';
import type { DemoContext } from '../context';
import type { GraphFactory } from '../engine/layout';
import { demoRoot } from '../engine/paths';
import { makeTestRepo, type TestRepo } from '../engine/read/testkit';
import { netOf } from '../engine/remote/network';
import { withOrigin } from '../engine/remote/testkit';
import { openForWrite } from '../engine/writeSeamTest';
import { type DemoForge, forgeOf } from './hub';
import type { ForgeFile } from './seed';
import { parseForgeFile } from './seed';

const oid = (c: string) => c.repeat(40);
const at = (day: number, h: number) => `2026-10-${String(day).padStart(2, '0')}T${String(h).padStart(2, '0')}:00:00Z`;
const HUD_DIFF = "@@ -3,3 +3,8 @@\n pub fn draw_hud(frame: &mut Frame) {\n     frame.margin(HUD_MARGIN);\n }\n+\n+/// The HUD's scale for a window `height` pixels tall.\n+pub fn hud_scale(height: u32) -> u32 {\n+    (height / 720).max(1)\n+}\n";

function mr(iid: number, title: string, source: string, target: string, author: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { iid, project: 'orbital/forge-lab', sourceBranch: source, targetBranch: target, title, state: 'opened', author, headSha: oid(String(iid)), baseSha: oid('b'), mergeStatus: 'mergeable', updatedAt: at(10, 9 + iid), diffs: [{ oldPath: 'README.md', newPath: 'README.md', diff: '@@ -1 +1,2 @@\n # Forge lab\n+A line\n' }], ...over };
}

export function forgeLabFile(): ForgeFile {
  const users = [
    { id: 101, username: 'ada', name: 'Ada Lovelace', email: 'ada@example.com', avatarUrl: null },
    { id: 102, username: 'grace', name: 'Grace Hopper', email: 'grace@example.com', avatarUrl: null },
    { id: 103, username: 'lars', name: 'Lars Tidemann', email: 'lars@example.com', avatarUrl: null },
  ];
  const you = { id: 100, username: 'you', name: 'You', email: 'you@example.com', avatarUrl: null };
  const note = (id: number, author: string, body: string, created: string, over: object = {}) => ({ id, author, body, createdAt: created, system: false, position: null, awards: [], ...over });
  return parseForgeFile(JSON.stringify({
    version: 1, host: 'gitlab.example.com', project: 'orbital/forge-lab', me: 'you',
    gitlab: {
      version: '18.9.1-ee',
      projects: [{ id: 4242, path: 'orbital/forge-lab', defaultBranch: 'main', httpUrl: 'https://gitlab.example.com/orbital/forge-lab.git', sshUrl: 'git@gitlab.example.com:orbital/forge-lab.git', updatedAt: at(10, 16) }],
      users, members: [you, ...users],
      labels: [{ name: 'hud', color: '#428bca', description: 'The heads-up display' }, { name: 'audio', color: '#d9534f', description: null }, { name: 'stack', color: '#5cb85c', description: null }],
      mergeRequests: [
        mr(1, 'Scale the HUD with the window', 'feature/hud-scale', 'main', 'ada', {
          description: 'The HUD keeps its size on big windows.\n\n- scales in whole steps\n- documented in `docs/hud.md`', pipeline: 'success', approvalsRequired: 1, mergeStatus: 'not_approved',
          reviewers: ['you', 'grace'], labels: ['hud'], subscribers: ['you'], diffs: [{ oldPath: 'src/hud.rs', newPath: 'src/hud.rs', diff: HUD_DIFF }],
          discussions: [
            { id: 'd1', notes: [note(101, 'grace', 'Looks good overall. One question on the rounding.', at(10, 11))] },
            { id: 'd2', resolvable: true, notes: [note(102, 'lars', 'Could this round to the nearest step instead?\n\n```suggestion\npub fn hud_scale(height: u32) -> u32 {\n```', at(10, 12), { position: { newPath: 'src/hud.rs', oldPath: 'src/hud.rs', newLine: 8, oldLine: null, start: null, headSha: oid('1') }, awards: [{ id: 501, name: 'thumbsup', user: 'grace' }] })] },
            { id: 'd3', resolvable: true, resolved: true, resolvedBy: 'grace', resolvedAt: at(10, 15), notes: [note(103, 'grace', 'Is 720 the right first step?', at(10, 13)), note(104, 'ada', "It's the smallest window we support.", at(10, 14))] },
            { id: 'd4', notes: [note(105, 'ada', 'added 1 commit', at(10, 16), { system: true })] },
          ],
        }),
        mr(2, 'Draft: Add a radar panel', 'feature/radar', 'main', 'grace', { pipeline: 'running', mergeStatus: 'draft_status' }),
        mr(3, 'Play the docking chime once, softer', 'fix/dock-chime', 'main', 'grace', { state: 'merged', mergeCommitSha: oid('m'), pipeline: 'success', labels: ['audio'], baseSha: '' }),
        mr(4, 'Add the cargo hold', 'feature/stack-a', 'main', 'ada', { approvedBy: ['grace'], approvalsRequired: 1, labels: ['stack'] }),
        mr(5, 'Give the hold a capacity', 'feature/stack-b', 'feature/stack-a', 'ada', { labels: ['stack'] }),
        mr(6, 'Allow accented station names', 'feature/ünï-names', 'main', 'lars'),
      ],
    },
  }));
}

export const UPLOAD_SECRET = '0123456789abcdef0123456789abcdef';
/** A PNG's signature and a little more: the media code sniffs the first bytes only. */
const UPLOAD_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

export const LAB_URL = 'https://gitlab.example.com/orbital/forge-lab.git';

export interface Lab { t: TestRepo; ctx: DemoContext & { events: AppEvent[] }; id: number; wt: string; forge: DemoForge }

/** `t` with `remote.origin.url` on the lab's project, `file` as its bundle's forge.json, opened for writes. */
async function labOn(t: TestRepo, file: ForgeFile): Promise<Lab> {
  await git.setConfig({ fs: t.memfs, dir: t.dir, path: 'remote.origin.url', value: LAB_URL });
  t.memfs.mkdirpSync('/demo/.extra/test');
  t.memfs.writeFileSync(demoRoot('test', 'forge.json'), JSON.stringify(file));
  const w = await openForWrite(t);
  netOf(w.ctx).fs = t.memfs;
  const forge = await forgeOf(w.ctx, t.memfs);
  forge.clock = () => 1_791_115_200;
  forge.fake.now = () => '2026-10-04T12:30:00Z';
  return { t, ...w, forge };
}

/** A repository whose `origin` is the lab's project, its MRs' source branches fetched (at made-up
 * commits). `graph`: the repository's graph layout (`noGraph` by default). */
export async function labCtx(o: { graph?: GraphFactory; upload?: boolean } = {}): Promise<Lab> {
  const t = await makeTestRepo('test', o.graph);
  await t.commit('Base');
  await git.writeRef({ fs: t.memfs, dir: t.dir, ref: 'refs/remotes/origin/feature/hud-scale', value: '1'.repeat(40) });
  await git.writeRef({ fs: t.memfs, dir: t.dir, ref: 'refs/remotes/origin/feature/ünï-names', value: '6'.repeat(40) });
  const file = forgeLabFile();
  if (o.upload) {
    file.gitlab.uploads = [`orbital/forge-lab/${UPLOAD_SECRET}/shot.png`, `orbital/forge-lab/${UPLOAD_SECRET}/clip.webm`];
    t.memfs.mkdirpSync(demoRoot('test', `forge-uploads/${UPLOAD_SECRET}`));
    t.memfs.writeFileSync(demoRoot('test', `forge-uploads/${UPLOAD_SECRET}/shot.png`), UPLOAD_PNG);
    t.memfs.writeFileSync(demoRoot('test', `forge-uploads/${UPLOAD_SECRET}/clip.webm`), new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3]));
  }
  return labOn(t, file);
}

/** `labCtx` with a real origin: `main` and `feature/stack-a` (one commit on main) pushed to
 * `demoRoot('test', 'origin.git')`, which the lab's URL reaches; `!4` is that branch's MR. No latency,
 * and the timers are kept in `timers` for the test to run. */
export async function labWithOrigin(): Promise<Lab & { origin: string; timers: (() => void)[] }> {
  const t = await makeTestRepo();
  const main = await t.commit('Base');
  await t.branch('feature/stack-a');
  await t.checkout('feature/stack-a');
  await t.write('hold.txt', 'cargo\n');
  const head = await t.commit('Add the cargo hold');
  await t.checkout('main');
  const origin = await withOrigin(t, ['main', 'feature/stack-a']);
  if (origin !== demoRoot('test', 'origin.git')) throw new Error(`the lab's origin is at ${origin}`);
  const file = forgeLabFile();
  const mr4 = file.gitlab.mergeRequests.find((m) => m.iid === 4)!;
  mr4.headSha = head;
  mr4.baseSha = main;
  const lab = await labOn(t, file);
  const timers: (() => void)[] = [];
  netOf(lab.ctx).latencyMs = 0;
  netOf(lab.ctx).schedule = (_ms, f) => void timers.push(f);
  return { ...lab, origin, timers };
}
