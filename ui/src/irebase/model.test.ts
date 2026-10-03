import { describe, expect, it } from 'vitest';
import {
  addChip, applyPreset, chipChange, chipRow, deleteChip, dirty, editMessage, fromPlan, grouping, mergedMessage, moveChip, moveRow, moveRows, moveSelected,
  predictionKey, problems, rebasedRow, reload, removeChip, reset, revertChip, samePlan, select, setActions, targetMessage, toRequest, type EditorState,
} from './model';
import { oid, plan } from './testPlan';

const order = (s: EditorState) => s.rows.map((r) => r.summary).join('');
const act = (s: EditorState, c: string, a: Parameters<typeof setActions>[2]) => setActions(s, [oid(c)], a);

describe('the rebase editor model (spec #3 §4.1, §7)', () => {
  it('opens on the plan: every row Pick, nothing selected, not dirty', () => {
    const s = fromPlan(plan());
    expect(order(s)).toBe('EDCBA');
    expect(s.rows.every((r) => r.action === 'pick' && r.edited === null)).toBe(true);
    expect(dirty(s)).toBe(false);
  });

  it('reorders: Ctrl+↑/↓ moves the selection a place; a drag moves a row', () => {
    let s = select(fromPlan(plan()), oid('c'));
    s = select(s, oid('b'), { ctrl: true });
    expect(order(moveSelected(s, -1))).toBe('ECBDA');
    expect(order(moveSelected(moveSelected(s, -1), -1))).toBe('CBEDA');
    expect(order(moveSelected(moveSelected(moveSelected(s, -1), -1), -1))).toBe('CBEDA'); // at the top: stays
    expect(order(moveSelected(s, 1))).toBe('EDACB');
    expect(order(moveRow(fromPlan(plan()), 0, 3))).toBe('DCBEA');
    expect(dirty(moveRow(fromPlan(plan()), 0, 3))).toBe(true);
  });

  it('a group drag lands the rows together, in their order, at a slot of the others; a scattered selection closes up (UX2 E.3)', () => {
    const s = fromPlan(plan()); // EDCBA
    expect(order(moveRows(s, [oid('d'), oid('b')], 0))).toBe('DBECA');
    expect(order(moveRows(s, [oid('b'), oid('d')], 3))).toBe('ECADB'); // the rows' order, not the selection's
    expect(order(moveRows(s, [oid('e'), oid('a')], 1))).toBe('DEACB');
    expect(order(moveRows(s, [oid('d'), oid('c')], 9))).toBe('EBADC'); // past the end: the bottom
    expect(moveRows(s, [oid('d'), oid('c')], 1)).toBe(s); // where they are: no change
    expect(moveRows(s, [], 0)).toBe(s);
  });

  it('selects: a click, Ctrl toggles, Shift takes the range from the anchor', () => {
    let s = select(fromPlan(plan()), oid('d'));
    s = select(s, oid('b'), { shift: true });
    expect(s.selected).toEqual([oid('d'), oid('c'), oid('b')]);
    s = select(s, oid('c'), { ctrl: true });
    expect(s.selected).toEqual([oid('d'), oid('b')]);
  });

  it('groups: Squash and Fixup fold down into the nearest row that is not dropped', () => {
    let s = act(fromPlan(plan()), 'd', 'squash');
    s = act(s, 'c', 'drop');
    s = act(s, 'e', 'fixup');
    const g = grouping(s.rows);
    expect(g.into.get(oid('d'))).toBe(oid('b'));
    expect(g.into.get(oid('e'))).toBe(oid('b'));
    expect(g.folded.get(oid('b'))).toEqual([oid('d'), oid('e')]);
    expect(g.into.has(oid('c'))).toBe(false);
  });

  it('the merged message: the target first, then each Squash row (never a Fixup), oldest first', () => {
    let s = act(fromPlan(plan()), 'd', 'squash');
    s = act(s, 'c', 'fixup');
    s = act(s, 'e', 'squash');
    expect(targetMessage(s, oid('b'))).toBe('B\n\nD\n\nE\n');
    s = editMessage(s, oid('e'), 'E, edited');
    expect(targetMessage(s, oid('b'))).toBe('B\n\nD\n\nE, edited\n');
    s = editMessage(s, oid('b'), 'All in one');
    expect(targetMessage(s, oid('b'))).toBe('All in one\n');
    expect(mergedMessage(['A\r\n', '', 'B\n\n'])).toBe('A\n\nB\n');
  });

  it('an edit equal to the default is no edit', () => {
    const s = editMessage(fromPlan(plan()), oid('c'), 'C\n\n');
    expect(s.rows.find((r) => r.oid === oid('c'))!.edited).toBeNull();
    expect(dirty(s)).toBe(false);
  });

  it('chips land where git leaves them: down past drops, into a fold target, else the base', () => {
    let s = act(fromPlan(plan()), 'b', 'drop');
    expect(chipRow(s, oid('b'))).toBe(oid('a')); // x moves down
    s = act(s, 'a', 'drop');
    expect(chipRow(s, oid('b'))).toBe(oid('0')); // nothing below survives: the base
    s = act(fromPlan(plan()), 'b', 'squash');
    expect(chipRow(s, oid('b'))).toBe(oid('a')); // b folds into a
    expect(rebasedRow(act(act(fromPlan(plan()), 'e', 'drop'), 'd', 'fixup'))).toBe(oid('c'));
  });

  it('chips: move, add (a valid, new name), remove (strike out; an added one goes); a locked chip stays', () => {
    let s = moveChip(fromPlan(plan()), 'x', oid('c'));
    expect(s.chips.find((c) => c.branch === 'x')!.at).toBe(oid('c'));
    expect(moveChip(s, 'y', oid('a')).chips.find((c) => c.branch === 'y')!.at).toBe(oid('d'));
    expect(addChip(s, 'x', oid('a'))).toBe('x already exists');
    expect(addChip(s, 'bad name', oid('a'))).toMatch(/./);
    const added = addChip(s, 'feature/new', oid('a')) as EditorState;
    expect(added.chips.at(-1)).toMatchObject({ branch: 'feature/new', at: oid('a'), origin: null, deleted: false });
    expect(removeChip(added, 'feature/new').chips.some((c) => c.branch === 'feature/new')).toBe(false);
    const struck = removeChip(added, 'x');
    expect(struck.chips.find((c) => c.branch === 'x')!.deleted).toBe(true);
    expect(removeChip(struck, 'x').chips.find((c) => c.branch === 'x')!.deleted).toBe(false);
    expect(removeChip(s, 'y')).toBe(s);
  });

  it('Reset restores the opening plan (with its preset)', () => {
    const opened = fromPlan(plan(), { rows: { [oid('c')]: 'squash' } });
    const edited = moveChip(moveRow(act(opened, 'e', 'drop'), 0, 2), 'x', oid('e'));
    expect(dirty(edited)).toBe(true);
    const back = reset(edited);
    expect(order(back)).toBe('EDCBA');
    expect(back.rows.find((r) => r.oid === oid('c'))!.action).toBe('squash');
    expect(dirty(back)).toBe(false);
  });

  it('a preset with gather brings its Squash rows right above the target (Squash interactively…)', () => {
    const s = fromPlan(plan(), { rows: { [oid('e')]: 'squash', [oid('c')]: 'squash' }, gather: oid('a') });
    expect(order(s)).toBe('DBECA');
    expect(grouping(s.rows).folded.get(oid('a'))).toEqual([oid('c'), oid('e')]);
  });

  it('problems: all dropped, nothing to squash into, a fold into Edit, an empty message', () => {
    expect(problems(fromPlan(plan()))).toEqual([]);
    expect(problems(setActions(fromPlan(plan()), ['e', 'd', 'c', 'b', 'a'].map(oid), 'drop'))[0]).toMatch(/^Every commit is dropped/);
    expect(problems(act(fromPlan(plan()), 'a', 'squash'))[0]).toBe('Nothing below aaaaaaa A to squash it into');
    expect(problems(act(act(fromPlan(plan()), 'b', 'fixup'), 'a', 'edit'))[0]).toMatch(/an Edit row/);
    expect(problems(editMessage(fromPlan(plan()), oid('c'), '  '))[0]).toBe('Write a message for ccccccc');
  });

  it('toRequest: actions, messages (a fold target always sends its merged one), chips', () => {
    let s = act(fromPlan(plan()), 'd', 'squash');
    s = act(s, 'e', 'drop');
    s = editMessage(s, oid('a'), 'A, reworded');
    s = removeChip(s, 'x');
    s = addChip(s, 'new', oid('e')) as EditorState;
    const req = toRequest(s);
    expect(req.rows.map((r) => r.action)).toEqual(['drop', 'squash', 'pick', 'pick', 'pick']);
    expect(req.rows.find((r) => r.oid === oid('c'))!.message).toBe('C\n\nD\n');
    expect(req.rows.find((r) => r.oid === oid('a'))!.message).toBe('A, reworded\n');
    expect(req.rows.find((r) => r.oid === oid('b'))!.message).toBeUndefined();
    expect(req.chips).toEqual([
      { branch: 'x', at: { kind: 'delete' } },
      { branch: 'y', at: { kind: 'row', oid: oid('d') } }, // locked: its own row, always
      { branch: 'new', at: { kind: 'new', oid: oid('c') } }, // on e, dropped: down to d, which folds into c
    ]);
  });

  it('reload keeps what it can: actions, messages and order of the commits still there; chip moves', () => {
    let old = moveRow(act(fromPlan(plan()), 'c', 'reword'), 3, 1); // E B D C A
    old = editMessage(old, oid('c'), 'C!');
    old = moveChip(old, 'x', oid('e'));
    // The branch moved on: a new commit f on top, and a was rewritten away (a different oid).
    const fresh = plan({ rows: [{ oid: oid('f'), summary: 'F', message: 'F\n', authorName: 'A', authorEmail: 'a@x', authorTime: 2, upstream: false }, ...plan().rows.slice(0, 4), { oid: oid('z'), summary: 'Z', message: 'Z\n', authorName: 'A', authorEmail: 'a@x', authorTime: 1, upstream: false }] });
    const s = reload(old, fresh);
    expect(order(s)).toBe('FEBDCZ');
    expect(s.rows.find((r) => r.oid === oid('c'))).toMatchObject({ action: 'reword', edited: 'C!\n' });
    expect(s.chips.find((c) => c.branch === 'x')!.at).toBe(oid('e'));
    expect(dirty(s)).toBe(true);
  });

  it('predictionKey changes with order, drops and folds, not with messages', () => {
    const s = fromPlan(plan());
    expect(predictionKey(editMessage(s, oid('c'), 'other'))).toBe(predictionKey(s));
    expect(predictionKey(act(s, 'c', 'drop'))).not.toBe(predictionKey(s));
    expect(predictionKey(moveRow(s, 0, 1))).not.toBe(predictionKey(s));
  });

  it('applyPreset without gather only sets actions', () => {
    expect(order(applyPreset(fromPlan(plan()), { rows: { [oid('c')]: 'drop' } }))).toBe('EDCBA');
  });

  it('the chip menu: deleteChip only strikes out (or drops an added chip); revertChip undoes the chip\'s change (UX R1.3)', () => {
    const s = fromPlan(plan());
    expect(chipChange(s.chips[0])).toBe('none');
    const del = deleteChip(s, 'x');
    expect(chipChange(del.chips[0])).toBe('deleted');
    expect(deleteChip(del, 'x')).toBe(del);
    expect(deleteChip(s, 'y')).toBe(s); // locked
    const moved = moveChip(s, 'x', oid('d'));
    expect(chipChange(moved.chips[0])).toBe('moved');
    expect(revertChip(moved, 'x').chips[0]).toEqual(s.chips[0]);
    expect(revertChip(del, 'x').chips[0]).toEqual(s.chips[0]);
    const added = addChip(s, 'n', oid('c')) as EditorState;
    expect(chipChange(added.chips[2])).toBe('added');
    expect(deleteChip(added, 'n').chips).toHaveLength(2);
    expect(revertChip(s, 'x')).toBe(s);
  });

  it('samePlan: the selection aside', () => {
    const s = fromPlan(plan());
    expect(samePlan(s, select(s, oid('c')))).toBe(true);
    expect(samePlan(s, moveSelected(select(s, oid('a')), 1))).toBe(true);
    expect(samePlan(s, act(s, 'c', 'drop'))).toBe(false);
    expect(samePlan(s, removeChip(s, 'x'))).toBe(false);
  });
});
