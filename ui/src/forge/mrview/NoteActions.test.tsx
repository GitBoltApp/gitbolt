import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ForgeDiscussion } from '../../api/gen/ForgeDiscussion';
import type { ForgeKind } from '../../api/gen/ForgeKind';
import type { ForgeNote } from '../../api/gen/ForgeNote';

const api = vi.hoisted(() => ({ forgeReact: vi.fn(), forgeEditNote: vi.fn(), forgeDeleteNote: vi.fn(async () => null), forgeResolve: vi.fn(), forgeReply: vi.fn(), openUrl: vi.fn(async () => null) }));
vi.mock('../../api/client', () => ({ api, errorMessage: (e: unknown) => String((e as { message?: string })?.message ?? e) }));
vi.mock('../usePolling', () => ({ notifyForgeWrite: vi.fn() }));
vi.mock('./openNote', () => ({ openNoteFile: vi.fn() }));
const transport = vi.hoisted(() => ({ copyText: vi.fn(async () => {}) }));
vi.mock('../../api/transport', async (orig) => ({ ...(await orig<object>()), ...transport }));

const { Discussion } = await import('./Thread');
const { notePermalink, toggled, withNote, useThreadFolds } = await import('./noteActions');
const { fullDate } = await import('./RelTime');
const { formatDate } = await import('../../format/date');
const { forgeOf, patchForge, useForge } = await import('../mrStore');
const { useRuntime } = await import('../../app/runtime');
const { useToast } = await import('../../ui/toast');
const { useMenu } = await import('../../menu/menuStore');
const { ContextMenu } = await import('../../menu/ContextMenu');
const { ArmLayer } = await import('../../ui/arm/ArmLayer');
const { disarm } = await import('../../ui/arm/store');
const { setOrigin } = await import('../../ui/arm/origin');
const { armClock, press } = await import('../../ui/arm/armTesting');
const { useReplyDrafts } = await import('./drafts');
const { mrOf, user } = await import('../testMrs');
const { preloadMarkdown } = await import('../../markdown/lazy');

beforeAll(() => preloadMarkdown(), 60_000);

const ada = user('Ada Lovelace');
const grace = user('Grace Hopper');
const mr = mrOf(12);
const note = (id: string, author = grace, over: Partial<ForgeNote> = {}): ForgeNote => ({ id, author, body: `Note ${id}`, createdAt: 1_791_100_000 + Number(id), system: false, position: null, ...over });
const thread = (id: string, notes: ForgeNote[], over: Partial<ForgeDiscussion> = {}): ForgeDiscussion => ({ id, notes, resolvable: false, resolved: false, ...over });

/** The thread as the store has it now (the view re-renders from it). */
function Live({ kind, id }: { kind: ForgeKind; id: string }) {
  const d = useForge((s) => s.byTab.t?.discussions[12]?.find((x) => x.id === id));
  return d ? <Discussion tabId="t" kind={kind} mr={mr} d={d} /> : <p>gone</p>;
}
const show = (kind: ForgeKind, d: ForgeDiscussion) => {
  patchForge('t', { kind, me: 'ada', discussions: { 12: [d] } });
  return render(<><Live kind={kind} id={d.id} /><p>elsewhere</p><ContextMenu /><ArmLayer /></>);
};
const notes = () => forgeOf('t').discussions[12]![0]!.notes;
const menu = (i = 0) => { fireEvent.click(screen.getAllByRole('button', { name: 'Comment actions' })[i]!); return screen.getByRole('menu'); };

let clock: ReturnType<typeof armClock>;
let rects: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  useForge.setState({ byTab: {} });
  useThreadFolds.setState({ open: {} });
  useReplyDrafts.setState({ text: {} });
  useRuntime.setState({ tabs: { t: { repo: { id: 4 } } as never } });
  useToast.getState().dismiss();
  useMenu.getState().close();
  clock = armClock();
  rects = vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function (this: HTMLElement) {
    return (this.isConnected ? [new DOMRect(10, 10, 20, 20)] : []) as unknown as DOMRectList;
  });
});
afterEach(() => {
  act(() => disarm());
  setOrigin(null);
  rects.mockRestore();
  clock.restore();
});

describe('a comment header: reactions, edit and delete', () => {
  it("has Add reaction and Comment actions; Edit and Delete only on the user's own comments", () => {
    show('gitlab', thread('d1', [note('101'), note('102', ada)]));
    expect(screen.getAllByRole('button', { name: 'Add reaction' })).toHaveLength(2);
    let m = menu(0);
    expect(within(m).getAllByRole('menuitem').map((r) => r.textContent)).toEqual(['Copy link', 'Quote reply']);
    act(() => useMenu.getState().close());
    m = menu(1);
    expect(within(m).getAllByRole('menuitem').map((r) => r.textContent)).toEqual(['Edit', 'Delete', 'Copy link', 'Quote reply']);
  });

  it('no reactions: no row; the first one from the picker shows a pill that is mine, and the last one removed takes the row away', async () => {
    api.forgeReact.mockResolvedValueOnce([{ name: 'thumbsup', count: 1, mine: true, users: ['Ada Lovelace'] }]).mockResolvedValueOnce([]);
    show('gitlab', thread('d1', [note('101')]));
    expect(screen.queryByRole('group', { name: 'Reactions' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add reaction' }));
    const picker = screen.getByRole('dialog', { name: 'Add reaction' });
    fireEvent.click(within(picker).getByRole('button', { name: ':thumbsup:' }));
    expect(screen.queryByRole('dialog', { name: 'Add reaction' })).toBeNull();
    // Shown at once, before the forge answers.
    const pill = screen.getByRole('button', { name: 'thumbsup: 1, yours' });
    expect(pill).toHaveAttribute('aria-pressed', 'true');
    expect(pill).toHaveTextContent('👍1');
    await waitFor(() => expect(api.forgeReact).toHaveBeenCalledWith(4, 12, { discussion: 'd1', note: '101' }, 'thumbsup', true));
    await waitFor(() => expect(notes()[0]!.reactions?.[0]?.users).toEqual(['Ada Lovelace']));
    fireEvent.click(screen.getByRole('button', { name: 'thumbsup: 1, yours' }));
    expect(screen.queryByRole('group', { name: 'Reactions' })).toBeNull();
    await waitFor(() => expect(api.forgeReact).toHaveBeenLastCalledWith(4, 12, { discussion: 'd1', note: '101' }, 'thumbsup', false));
  });

  it("a pill toggles the user's own, and a refusal puts it back with the reason", async () => {
    api.forgeReact.mockRejectedValueOnce({ message: 'gitlab.example.com refused: 403 Forbidden' });
    show('gitlab', thread('d1', [note('101', grace, { reactions: [{ name: 'tada', count: 2, mine: false, users: ['Grace Hopper', 'Alan'] }] })]));
    fireEvent.click(screen.getByRole('button', { name: 'tada: 2' }));
    expect(screen.getByRole('button', { name: 'tada: 3, yours' })).toBeInTheDocument();
    await waitFor(() => expect(useToast.getState().message).toBe("Couldn't add the reaction: gitlab.example.com refused: 403 Forbidden"));
    expect(screen.getByRole('button', { name: 'tada: 2' })).toHaveAttribute('aria-pressed', 'false');
  });

  it("GitHub's picker is its eight; GitLab's also searches every emoji name", async () => {
    const { unmount } = show('github', thread('issue-41', [note('41')]));
    fireEvent.click(screen.getByRole('button', { name: 'Add reaction' }));
    expect(within(screen.getByRole('dialog', { name: 'Add reaction' })).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([':+1:', ':-1:', ':laugh:', ':hooray:', ':confused:', ':heart:', ':rocket:', ':eyes:']);
    expect(screen.queryByRole('searchbox', { name: 'Search emoji' })).toBeNull();
    unmount();
    show('gitlab', thread('d1', [note('101')]));
    fireEvent.click(screen.getByRole('button', { name: 'Add reaction' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search emoji' }), { target: { value: 'unicorn' } });
    await waitFor(() => expect(screen.getByRole('button', { name: ':unicorn:' })).toHaveTextContent('🦄'));
    // jsdom: the closed context menu's element is no longer "shown" once boxes are real again.
    rects.mockRestore();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Add reaction' })).toBeNull();
  });

  it('Edit turns the comment into its Markdown field with Cancel then Save; Save puts the forge’s text in', async () => {
    api.forgeEditNote.mockResolvedValue(note('102', ada, { body: 'Fixed the typo' }));
    show('gitlab', thread('d1', [note('101'), note('102', ada, { body: 'Fixed teh typo' })]));
    fireEvent.click(within(menu(1)).getByRole('menuitem', { name: /Edit/ }));
    const form = screen.getByRole('form', { name: 'Edit comment' });
    expect(within(form).getAllByRole('button').filter((b) => ['Cancel', 'Save'].includes(b.textContent ?? '')).map((b) => b.textContent)).toEqual(['Cancel', 'Save']);
    const box = within(form).getByRole('textbox', { name: 'Edit comment' });
    expect(box).toHaveValue('Fixed teh typo');
    fireEvent.change(box, { target: { value: 'Fixed the typo' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Edit comment' })).toBeNull());
    expect(api.forgeEditNote).toHaveBeenCalledWith(4, 12, { discussion: 'd1', note: '102' }, 'Fixed the typo');
    expect(notes()[1]!.body).toBe('Fixed the typo');
  });

  it('Delete arms in place, then deletes; the only comment takes its thread with it', async () => {
    show('gitlab', thread('d1', [note('102', ada)]));
    press(within(menu()).getByRole('menuitem', { name: /Delete/ }));
    // The menu row itself arms: it says what the second click does.
    const armed = within(screen.getByRole('menu')).getByRole('menuitem', { name: /Click again to delete the comment/ });
    expect(api.forgeDeleteNote).not.toHaveBeenCalled();
    clock.settle();
    press(armed);
    await waitFor(() => expect(screen.getByText('gone')).toBeInTheDocument());
    expect(api.forgeDeleteNote).toHaveBeenCalledWith(4, 12, { discussion: 'd1', note: '102' });
  });

  it('Copy link copies the permalink; Quote reply quotes into the thread’s reply box', async () => {
    show('gitlab', thread('d1', [note('101', grace, { body: 'Line one\nLine two' })]));
    fireEvent.click(within(menu()).getByRole('menuitem', { name: /Copy link/ }));
    await waitFor(() => expect(transport.copyText).toHaveBeenCalledWith('https://gitlab.example.com/group/project/-/merge_requests/12#note_101'));
    fireEvent.click(within(menu()).getByRole('menuitem', { name: /Quote reply/ }));
    expect(screen.getByRole('textbox', { name: 'Reply' })).toHaveValue('> Line one\n> Line two\n\n');
  });

  it("right-clicking the date opens the app's menu with Copy link and Open in browser", () => {
    show('github', thread('issue-41', [note('41', grace, { webUrl: 'https://github.com/octo-org/widget/pull/3#issuecomment-41' })]));
    fireEvent.contextMenu(screen.getByText(/ago$/));
    const m = screen.getByRole('menu');
    expect(within(m).getAllByRole('menuitem').map((r) => r.textContent)).toEqual(['Copy link', 'Open in browser']);
    fireEvent.click(within(m).getByRole('menuitem', { name: /Open in browser/ }));
    expect(api.openUrl).toHaveBeenCalledWith('https://github.com/octo-org/widget/pull/3#issuecomment-41');
  });

  it("a GitHub review's summary takes no reactions and can't be edited", () => {
    patchForge('t', { me: 'grace' });
    show('github', thread('review-31', [note('review-31')]));
    expect(screen.queryByRole('button', { name: 'Add reaction' })).toBeNull();
    expect(within(menu()).getAllByRole('menuitem').map((r) => r.textContent)).toEqual(['Quote reply']);
  });
});

describe('resolvable threads and folded replies', () => {
  const replies = [note('101'), note('102', ada), note('103', user('Alan Turing'))];

  it('Resolve shows at once and turns green; the forge says by whom; a refusal puts it back', async () => {
    api.forgeResolve.mockResolvedValueOnce({ resolved: true, resolvedBy: 'Ada Lovelace' }).mockRejectedValueOnce({ message: 'refused: 403 Forbidden' });
    show('gitlab', thread('d2', [note('101')], { resolvable: true }));
    const button = screen.getByRole('button', { name: 'Resolve thread' });
    expect(button).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(button);
    expect(screen.getByRole('button', { name: 'Unresolve thread' })).toHaveClass('on');
    await waitFor(() => expect(forgeOf('t').discussions[12]![0]!.resolvedBy).toBe('Ada Lovelace'));
    expect(api.forgeResolve).toHaveBeenCalledWith(4, 12, 'd2', true);
    fireEvent.click(screen.getByRole('button', { name: 'Unresolve thread' }));
    await waitFor(() => expect(useToast.getState().message).toBe("Couldn't unresolve the thread: refused: 403 Forbidden"));
    expect(screen.getByRole('button', { name: 'Unresolve thread' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('a thread that is not resolvable has no Resolve', () => {
    show('gitlab', thread('d1', [note('101')]));
    expect(screen.queryByRole('button', { name: /Resolve thread/ })).toBeNull();
  });

  it('a resolved thread folds its replies by default: the first comment, then who replied and when; the row unfolds it and the choice is kept', () => {
    const { unmount } = show('gitlab', thread('d2', replies, { resolvable: true, resolved: true }));
    expect(screen.getByText('Note 101')).toBeInTheDocument();
    expect(screen.queryByText('Note 102')).toBeNull();
    expect(screen.queryByRole('button', { name: /Reply/ })).toBeNull();
    const toggle = screen.getByRole('button', { name: '2 replies' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText(/Last reply by Alan Turing/)).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Collapse replies' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.queryByText(/Last reply by/)).toBeNull();
    expect(screen.getByText('Note 103')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Reply/ })).toBeInTheDocument();
    unmount();
    show('gitlab', thread('d2', replies, { resolvable: true, resolved: true }));
    expect(screen.getByText('Note 103')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse replies' }));
    expect(screen.queryByText('Note 103')).toBeNull();
  });

  it('an unresolved thread shows its replies, and folds them on the row; one without replies has no row', () => {
    const { unmount } = show('gitlab', thread('d2', replies, { resolvable: true }));
    expect(screen.getByText('Note 103')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse replies' }));
    expect(screen.queryByText('Note 103')).toBeNull();
    unmount();
    show('gitlab', thread('d9', [note('101')], { resolvable: true, resolved: true }));
    expect(screen.queryByRole('button', { name: /repl/ })).toBeNull();
  });
});

describe('permalinks, date tooltips and reaction lists', () => {
  it("GitLab's is the MR's address and #note_<id>; GitHub's is the comment's own", () => {
    expect(notePermalink('gitlab', { webUrl: 'https://gitlab.example.com/g/p/-/merge_requests/12' }, { id: '101', webUrl: undefined })).toBe('https://gitlab.example.com/g/p/-/merge_requests/12#note_101');
    expect(notePermalink('github', { webUrl: 'https://github.com/o/r/pull/3' }, { id: '52', webUrl: 'https://github.com/o/r/pull/3#discussion_r52' })).toBe('https://github.com/o/r/pull/3#discussion_r52');
    expect(notePermalink('github', { webUrl: 'https://github.com/o/r/pull/3' }, { id: '52', webUrl: undefined })).toBeNull();
  });

  it('the tooltip is the full date in the chosen format with the time zone', () => {
    const t = 1_791_100_000;
    expect(fullDate(t, 'ymd24h', () => 'EDT')).toBe(`${formatDate(t, 'ymd24h')} EDT`);
    expect(fullDate(t, 'mdy12h', () => 'GMT+2')).toBe(`${formatDate(t, 'mdy12h')} GMT+2`);
    expect(fullDate(t, 'dmy24h', () => '')).toBe(formatDate(t, 'dmy24h'));
  });

  it('toggling a reaction adds or removes the user, and an emptied one goes', () => {
    expect(toggled([], 'heart', true, 'ada')).toEqual([{ name: 'heart', count: 1, mine: true, users: ['ada'] }]);
    const two = [{ name: 'heart', count: 2, mine: true, users: ['grace', 'ada'] }];
    expect(toggled(two, 'heart', false, 'ada')).toEqual([{ name: 'heart', count: 1, mine: false, users: ['grace'] }]);
    expect(toggled(toggled(two, 'heart', false, 'ada'), 'heart', false, 'ada')).toHaveLength(1);
    expect(toggled([{ name: 'heart', count: 1, mine: true, users: ['ada'] }], 'heart', false, 'ada')).toEqual([]);
  });

  it('removing a note keeps its thread while a comment is left', () => {
    const d = thread('d1', [note('1'), note('2')]);
    expect(withNote([d], 'd1', '2', () => null)[0]!.notes.map((n) => n.id)).toEqual(['1']);
    expect(withNote([thread('d1', [note('1'), note('2', grace, { system: true })])], 'd1', '1', () => null)).toEqual([]);
  });
});

describe('thread header polish', () => {
  const pos = { path: 'src/app.php', oldPath: null, line: 1, oldLine: null, snippet: null, startLine: null, startOldLine: null };

  it("a diff note's author and date lead the card; the file link sits below them, above the body", () => {
    show('gitlab', thread('d1', [note('101', grace, { position: pos })]));
    const head = document.querySelector('.mr-note-head')!;
    const where = screen.getByRole('button', { name: 'src/app.php:1' });
    const body = screen.getByText('Note 101');
    expect(head.textContent).toContain('Grace Hopper');
    expect(head.compareDocumentPosition(where) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(where.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("clicking a comment's date opens its link menu at the date", () => {
    show('gitlab', thread('d1', [note('101')]));
    fireEvent.click(screen.getByRole('button', { name: /ago|now|\d{4}/ }));
    const m = screen.getByRole('menu');
    expect(within(m).getAllByRole('menuitem').map((r) => r.textContent)).toEqual(['Copy link', 'Open in browser']);
  });
});
