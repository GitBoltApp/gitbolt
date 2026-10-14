// A merge's files in the worktree's own git dir (MERGE_HEAD, MERGE_MSG, MERGE_MODE, and git 2.42's
// AUTO_MERGE), written when a merge stops on conflicts, read by Commit (the merge commit's other
// parents), cleared once it's made or aborted; and ORIG_HEAD, which `git merge` leaves behind.
import { dwimRefName } from '../read/revs';
import { readRaw } from '../read/trees';
import { readRef } from './refs';
import type { WriteWt } from './seam';

/** Every oid MERGE_HEAD lists (an octopus merge's several); empty when there's none. */
export function readMergeHead(wt: WriteWt): string[] {
  try {
    return (wt.fs.readFileSync(`${wt.gitdir}/MERGE_HEAD`, 'utf8') as string)
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '');
  } catch {
    return [];
  }
}

export function clearMergeState(wt: WriteWt): void {
  for (const f of ['MERGE_HEAD', 'MERGE_MSG', 'MERGE_MODE', 'AUTO_MERGE', 'SQUASH_MSG']) if (wt.fs.existsSync(`${wt.gitdir}/${f}`, false)) wt.fs.unlinkSync(`${wt.gitdir}/${f}`);
}

/** git's merge message for `target` as given: "Merge branch|remote-tracking branch|tag|commit '<target>'", " into <branch>" unless main/master, an annotated tag's message after a blank line. */
export async function mergeMessage(wt: WriteWt, target: string, branch: string): Promise<string> {
  const full = dwimRefName(wt.repo, target);
  const kind = full?.startsWith('refs/heads/') ? 'branch' : full?.startsWith('refs/remotes/') ? 'remote-tracking branch' : full?.startsWith('refs/tags/') ? 'tag' : 'commit';
  const into = branch === 'main' || branch === 'master' ? '' : ` into ${branch}`;
  let message = `Merge ${kind} '${target}'${into}\n`;
  if (kind === 'tag') {
    const raw = await readRaw(wt.repo, readRef(wt.demo, full!)!);
    if (raw?.type === 'tag') {
      const text = new TextDecoder().decode(raw.bytes);
      const body = text.slice(text.indexOf('\n\n') + 2);
      if (body.trim() !== '') message += `\n${body.endsWith('\n') ? body : `${body}\n`}`;
    }
  }
  return message;
}

/** A message file git leaves at a stop on conflicts: the message, then its conflicted paths under
 *  `# Conflicts:` (a message without its final newline gets one, and no blank line). */
export const withConflicts = (message: string, conflicts: string[]): string => `${message}\n# Conflicts:\n${conflicts.map((p) => `#\t${p}\n`).join('')}`;

/** A merge stopped on conflicts: its files, as git leaves them (`autoMerge`: the tree of the result
 *  with its conflict markers, AUTO_MERGE). */
export function writeMergeState(wt: WriteWt, s: { mergeHead: string; message: string; conflicts: string[]; autoMerge?: string }): void {
  wt.fs.writeFileSync(`${wt.gitdir}/MERGE_HEAD`, `${s.mergeHead}\n`);
  wt.fs.writeFileSync(`${wt.gitdir}/MERGE_MSG`, withConflicts(s.message, s.conflicts));
  wt.fs.writeFileSync(`${wt.gitdir}/MERGE_MODE`, '');
  if (s.autoMerge !== undefined) wt.fs.writeFileSync(`${wt.gitdir}/AUTO_MERGE`, `${s.autoMerge}\n`);
}

export function writeOrigHead(wt: WriteWt, oid: string): void {
  wt.fs.writeFileSync(`${wt.gitdir}/ORIG_HEAD`, `${oid}\n`);
}
