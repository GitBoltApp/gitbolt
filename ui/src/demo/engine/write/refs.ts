// Refs as the core moves them (write/refs.rs): every move a CAS, the old value checked first (all
// or nothing), then a loose file written, or the ref deleted from its loose file and from
// `packed-refs`. HEAD is the worktree's own file. Only `refs/stash` keeps a reflog here: it's the
// one the demo reads (the stash list).
import type { GbError } from '../../../api/gen/GbError';
import { gbError } from '../errors';
import { parentOf } from '../memfs';
import type { DemoRepo } from '../repo';
import type { WriteWt } from './seam';

/** One ref's move: `old` null didn't exist, `new` null deletes. */
export interface RefMove {
  name: string;
  old: string | null;
  new: string | null;
}

/** HEAD as the journal records it: its branch's short name (null detached), its commit (null unborn). */
export interface HeadState {
  branch: string | null;
  oid: string | null;
}

export const ZERO_OID = '0'.repeat(40);

export function shortRef(name: string): string {
  for (const p of ['refs/heads/', 'refs/remotes/', 'refs/tags/', 'refs/']) if (name.startsWith(p)) return name.slice(p.length);
  return name;
}

export const refMoved = (name: string): GbError => gbError('RefMoved', `${shortRef(name)} changed outside GitVolt`);

/** The ref's object id (a symbolic ref followed; an annotated tag's own object), null when it doesn't exist. */
export function readRef(demo: DemoRepo, name: string): string | null {
  return demo.resolveRef(demo.refMap(), name);
}

function pruneRefDirs(demo: DemoRepo, dir: string): void {
  for (let d = dir; d.startsWith(`${demo.gitdir}/refs/`) && !/\/refs\/(heads|tags|remotes)$/.test(d); d = parentOf(d)) {
    try {
      if (demo.fs.readdirSync(d).length > 0) return;
      demo.fs.rmdirSync(d);
    } catch {
      return;
    }
  }
}

export function deleteRefFiles(demo: DemoRepo, name: string): void {
  const loose = `${demo.gitdir}/${name}`;
  if (demo.fs.existsSync(loose, false)) {
    demo.fs.unlinkSync(loose);
    pruneRefDirs(demo, parentOf(loose));
  }
  const log = `${demo.gitdir}/logs/${name}`; // git drops a ref's log with it
  if (demo.fs.existsSync(log, false)) demo.fs.unlinkSync(log);
  let text: string;
  try {
    text = demo.fs.readFileSync(`${demo.gitdir}/packed-refs`, 'utf8') as string;
  } catch {
    return;
  }
  const out: string[] = [];
  let dropPeeled = false;
  for (const line of text.split('\n')) {
    if (dropPeeled && line.startsWith('^')) continue;
    dropPeeled = /^[0-9a-f]{40} /.test(line) && line.slice(41) === name;
    if (!dropPeeled) out.push(line);
  }
  const next = out.join('\n');
  if (next !== text) demo.fs.writeFileSync(`${demo.gitdir}/packed-refs`, next);
}

/** Refused before anything moves: a stale `old`, a symbolic ref, or a name clashing with another
 *  ref's folder (`a` beside `a/b`). */
export function casRefs(demo: DemoRepo, moves: RefMove[]): void {
  const refs = demo.refMap();
  for (const m of moves) {
    if (!m.name.startsWith('refs/') || refs.get(m.name)?.symref) throw gbError('InvalidInput', `${m.name}: ref moves name concrete refs, not symbolic ones`);
    if (m.old === null && m.new === null) throw gbError('InvalidInput', `${m.name}: nothing to do`);
    if (demo.resolveRef(refs, m.name) !== m.old) throw refMoved(m.name);
    if (m.old === null) {
      const clash = [...refs.keys()].find((n) => n.startsWith(`${m.name}/`) || m.name.startsWith(`${n}/`));
      if (clash) throw gbError('InvalidInput', `${shortRef(m.name)} can't be made: ${shortRef(clash)} exists`);
    }
  }
  for (const m of moves) {
    if (m.new === null) deleteRefFiles(demo, m.name);
    else {
      const p = `${demo.gitdir}/${m.name}`;
      demo.fs.mkdirpSync(parentOf(p));
      demo.fs.writeFileSync(p, `${m.new}\n`);
    }
  }
}

export function readHead(wt: WriteWt): HeadState {
  const { head, branch } = wt.demo.headOf(`${wt.gitdir}/HEAD`, wt.demo.refMap());
  return { branch: branch?.startsWith('refs/heads/') ? branch.slice('refs/heads/'.length) : null, oid: head };
}

export function setHead(wt: WriteWt, to: { branch: string } | { oid: string }): void {
  wt.fs.writeFileSync(`${wt.gitdir}/HEAD`, 'branch' in to ? `ref: refs/heads/${to.branch}\n` : `${to.oid}\n`);
}

/** One reflog line, appended: `<old> <new> <ident>\t<message>`. */
export function appendReflog(demo: DemoRepo, ref: string, old: string | null, next: string | null, ident: string, message: string): void {
  const p = `${demo.gitdir}/logs/${ref}`;
  demo.fs.mkdirpSync(parentOf(p));
  const prev = demo.fs.existsSync(p) ? (demo.fs.readFileSync(p, 'utf8') as string) : '';
  demo.fs.writeFileSync(p, `${prev}${old ?? ZERO_OID} ${next ?? ZERO_OID} ${ident}\t${message}\n`);
}
