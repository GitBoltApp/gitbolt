import { describe, expect, it } from 'vitest';
import type { ChipPlan } from '../../../api/gen/ChipPlan';
import type { RebaseRowAction } from '../../../api/gen/RebaseRowAction';
import { buildTodo, type PlannedRow, type TodoPlan } from './todo';

const oid = (c: string) => c.repeat(40);
const row = (c: string, action: RebaseRowAction, message?: string): PlannedRow => ({ oid: oid(c), action, original: `${c.toUpperCase()}\n`, guard: `ada@example.com ${c.charCodeAt(0)} ${c.toUpperCase()}`, ...(message !== undefined ? { message } : {}) });
const plan = (rows: PlannedRow[], chips: ChipPlan[] = [], locked: [string, string][] = []): TodoPlan => ({
  branch: 'c', base: oid('0'), rows, chips, tips: new Map([['a', oid('a')], ['b', oid('b')], ['c', oid('c')]]), locked: new Map(locked),
});
const pick = (c: string) => ({ op: 'pick', oid: oid(c), parent: null });
/** The guarded exec: target `c`'s new message, amended in while HEAD is still `c`'s commit. */
const exec = (n: number, c: string, message: string) => ({ op: 'line', text: `exec sh ${n}.sh`, amend: { message, guard: `ada@example.com ${c.charCodeAt(0)} ${c.toUpperCase()}` } });
const ref = (b: string) => ({ op: 'updateRef', ref: `refs/heads/${b}` });

// The core's todo.rs tests, as steps: its guarded `exec` after a changed message is a `line` step
// that amends (git counts it), and a `# dropped` comment is none.
describe('buildTodo', () => {
  it('replays picks oldest first', () => {
    const t = buildTodo(plan([row('c', 'pick'), row('b', 'pick'), row('a', 'pick')]));
    expect(t.steps).toEqual([pick('a'), pick('b'), pick('c')]);
    expect(t).toMatchObject({ updateRefs: [], deletes: [] });
  });

  it('a reword amends through its guarded exec line; an unchanged one adds none', () => {
    expect(buildTodo(plan([row('c', 'pick'), row('b', 'reword', 'B, reworded\n\nBody'), row('a', 'pick')])).steps).toEqual([
      pick('a'), pick('b'), exec(1, 'b', 'B, reworded\n\nBody\n'), pick('c'),
    ]);
    expect(buildTodo(plan([row('b', 'reword', 'B\r\n\n'), row('a', 'pick')])).steps).toEqual([pick('a'), pick('b')]);
  });

  it('a squash group merges its messages, skipping fixups and drops, guarded on its target', () => {
    const t = buildTodo(plan([row('e', 'squash'), row('d', 'fixup'), row('c', 'drop'), row('b', 'squash'), row('a', 'pick')]));
    expect(t.steps).toEqual([
      pick('a'),
      { op: 'fold', oid: oid('b'), fixup: true },
      { op: 'fold', oid: oid('d'), fixup: true },
      { op: 'fold', oid: oid('e'), fixup: true },
      exec(1, 'a', 'A\n\nB\n\nE\n'),
    ]);
  });

  it("a fixup-only group keeps the target's message; a reword target its own", () => {
    expect(buildTodo(plan([row('b', 'fixup'), row('a', 'pick')])).steps).toEqual([pick('a'), { op: 'fold', oid: oid('b'), fixup: true }]);
    expect(buildTodo(plan([row('b', 'squash'), row('a', 'reword', 'A and B together')])).steps).toEqual([
      pick('a'), { op: 'fold', oid: oid('b'), fixup: true }, exec(1, 'a', 'A and B together\n'),
    ]);
  });

  it('an Edit row stops, its new message the stop\'s (no exec)', () => {
    expect(buildTodo(plan([row('b', 'edit', 'B at the stop'), row('a', 'pick')])).steps).toEqual([pick('a'), { ...pick('b'), edit: true, message: 'B at the stop\n' }]);
  });

  it('numbers the exec lines as the message files, an Edit row\'s included', () => {
    const t = buildTodo(plan([row('c', 'reword', 'C2'), row('b', 'edit', 'B2'), row('a', 'reword', 'A2')]));
    expect(t.steps).toEqual([pick('a'), exec(1, 'a', 'A2\n'), { ...pick('b'), edit: true, message: 'B2\n' }, pick('c'), exec(3, 'c', 'C2\n')]);
  });

  it('refuses what the core refuses', () => {
    expect(() => buildTodo(plan([row('a', 'pick'), row('a', 'pick')]))).toThrow(`${oid('a').slice(0, 7)} is in the plan twice`);
    expect(() => buildTodo(plan([row('b', 'pick'), row('a', 'squash')]))).toThrow(`Nothing below ${oid('a').slice(0, 7)} A to squash it into`);
    expect(() => buildTodo(plan([row('b', 'fixup'), row('a', 'edit')]))).toThrow(`${oid('b').slice(0, 7)} can't fold into ${oid('a').slice(0, 7)}: an Edit row stops before the commits above it fold in`);
    expect(() => buildTodo(plan([row('b', 'drop'), row('a', 'drop')]))).toThrow('Every commit is dropped: keep at least one, or cancel the rebase');
    expect(() => buildTodo(plan([row('b', 'reword', '  \n'), row('a', 'pick')]))).toThrow(`Write a message for ${oid('b').slice(0, 7)}`);
    // Drops don't open a group.
    expect(() => buildTodo(plan([row('b', 'squash'), row('a', 'drop')]))).toThrow(`Nothing below ${oid('b').slice(0, 7)} B`);
    expect(() => buildTodo(plan([row('c', 'fixup'), row('b', 'drop'), row('a', 'edit')]))).toThrow('an Edit row');
    expect(() => buildTodo(plan([row('a', 'pick'), row('a', 'pick')]))).toThrow(expect.objectContaining({ kind: 'InvalidInput' }));
  });

  it('places chips: after their group, at the base, moved, new, deleted, staying', () => {
    const chips: ChipPlan[] = [
      { branch: 'a', at: { kind: 'row', oid: oid('b') } },
      { branch: 'b', at: { kind: 'delete' } },
      { branch: 'n', at: { kind: 'new', oid: oid('0') } },
      { branch: 'c', at: { kind: 'row', oid: oid('c') } },
    ];
    const t = buildTodo(plan([row('c', 'pick'), row('b', 'pick'), row('a', 'pick')], chips));
    expect(t.steps).toEqual([ref('n'), pick('a'), pick('b'), ref('a'), pick('c')]);
    expect(t.deletes).toEqual(['b']);
    expect(t.updateRefs).toEqual(['n', 'a']);
    expect(() => buildTodo(plan([row('a', 'pick')], [{ branch: 'c', at: { kind: 'row', oid: oid('0') } }]))).toThrow('c is the rebased branch: it stays on the top commit');
    expect(() => buildTodo(plan([row('a', 'pick')], [{ branch: 'b', at: { kind: 'new', oid: oid('a') } }]))).toThrow('b already exists');
    expect(() => buildTodo(plan([row('a', 'pick')], [{ branch: 'zz', at: { kind: 'stay' } }]))).toThrow("zz doesn't exist");
    expect(() => buildTodo(plan([row('a', 'pick')], [{ branch: 'x y', at: { kind: 'new', oid: oid('a') } }]))).toThrow('"x y" isn\'t a valid branch name');
    expect(() => buildTodo(plan([row('a', 'pick')], [{ branch: 'gone', at: { kind: 'row', oid: oid('a') } }]))).toThrow("gone doesn't exist");
    expect(() => buildTodo(plan([row('a', 'pick')], [{ branch: 'a', at: { kind: 'row', oid: oid('9') } }]))).toThrow(`a: ${oid('9').slice(0, 7)} isn't one of the rebased commits`);
    expect(() => buildTodo(plan([row('a', 'pick')], [{ branch: 'b', at: { kind: 'delete' } }, { branch: 'b', at: { kind: 'stay' } }]))).toThrow('b has two chips');
  });

  it('chips follow their rows through folds and drops', () => {
    const rows = [row('e', 'drop'), row('d', 'squash'), row('c', 'pick'), row('b', 'drop'), row('a', 'drop')];
    const chips: ChipPlan[] = [
      { branch: 'on-squash', at: { kind: 'new', oid: oid('d') } },
      { branch: 'on-drop', at: { kind: 'new', oid: oid('e') } },
      { branch: 'a', at: { kind: 'row', oid: oid('b') } },
      { branch: 'b', at: { kind: 'row', oid: oid('0') } },
      { branch: 'c', at: { kind: 'row', oid: oid('c') } },
    ];
    const t = buildTodo(plan(rows, chips));
    expect(t.steps).toEqual([ref('a'), ref('b'), pick('c'), { op: 'fold', oid: oid('d'), fixup: true }, exec(1, 'c', 'C\n\nD\n'), ref('on-drop'), ref('on-squash')]);
    expect(t.updateRefs).toEqual(['a', 'b', 'on-drop', 'on-squash']);
  });

  it('a locked chip on its own tip and a Stay chip get no step; a locked one elsewhere is refused', () => {
    const rows = () => [row('c', 'pick'), row('b', 'pick'), row('a', 'pick')];
    expect(buildTodo(plan(rows(), [{ branch: 'a', at: { kind: 'row', oid: oid('a') } }], [['a', 'checked out in /w']])).steps).toEqual([pick('a'), pick('b'), pick('c')]);
    expect(buildTodo(plan(rows(), [{ branch: 'a', at: { kind: 'stay' } }, { branch: 'b', at: { kind: 'stay' } }], [['a', 'checked out in /w']]))).toEqual({ steps: [pick('a'), pick('b'), pick('c')], updateRefs: [], deletes: [] });
    expect(() => buildTodo(plan(rows(), [{ branch: 'a', at: { kind: 'delete' } }], [['a', 'checked out in /w']]))).toThrow('a can\'t move: checked out in /w');
  });

  it("the rebased branch's chip may sit on the effective top", () => {
    expect(() => buildTodo(plan([row('c', 'drop'), row('b', 'pick'), row('a', 'pick')], [{ branch: 'c', at: { kind: 'row', oid: oid('c') } }]))).not.toThrow();
    expect(() => buildTodo(plan([row('c', 'fixup'), row('b', 'pick'), row('a', 'pick')], [{ branch: 'c', at: { kind: 'row', oid: oid('b') } }]))).not.toThrow();
    expect(() => buildTodo(plan([row('c', 'pick'), row('b', 'pick')], [{ branch: 'c', at: { kind: 'new', oid: oid('c') } }]))).toThrow('c is the rebased branch');
  });

  it("an oid's short form never splits a character", () => {
    expect(() => buildTodo(plan([row('a', 'pick')], [{ branch: 'a', at: { kind: 'row', oid: 'ééééé' } }]))).toThrow("a: ééééé isn't one of the rebased commits");
  });
});
