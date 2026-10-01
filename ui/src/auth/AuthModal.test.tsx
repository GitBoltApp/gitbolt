import { act, fireEvent, render, screen } from '@testing-library/react';
import { KeyRound } from 'lucide-react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerKeys } from '../ui/keyRouter';

const authAnswer = vi.fn(async (..._a: unknown[]) => null as unknown);
vi.mock('../api/client', () => ({ api: { authAnswer: (...a: unknown[]) => authAnswer(...a) }, onEvent: () => () => {} }));
const { AuthModal } = await import('./AuthModal');
const { useOps } = await import('../app/ops');
const { useMenu } = await import('../menu/menuStore');
const { RefPicker } = await import('../ui/RefPicker');

const ask = (prompt: number, text: string, secret: boolean) =>
  act(() => useOps.getState().apply({ type: 'authWaiting', prompt, op: 1, repo: null, text, secret }));

describe('AuthModal', () => {
  beforeEach(() => {
    authAnswer.mockClear();
    authAnswer.mockImplementation(async () => null);
    useOps.setState({ ops: {}, prompts: [], errors: [], unread: 0 });
  });

  it('asks with a password field for secrets and answers or cancels', () => {
    render(<AuthModal />);
    ask(5, "Password for 'https://ada@h': ", true);
    expect(screen.getByText("Password for 'https://ada@h':")).toBeInTheDocument();
    const input = screen.getByLabelText('Password');
    expect(input).toHaveAttribute('type', 'password');
    fireEvent.change(input, { target: { value: 's3cret' } });
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(authAnswer).toHaveBeenLastCalledWith(5, 's3cret');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(authAnswer).toHaveBeenLastCalledWith(5, null);
  });

  it('asks with a plain text field otherwise, focused; the next prompt starts empty', () => {
    render(<AuthModal />);
    ask(6, "Username for 'https://h': ", false);
    const input = screen.getByLabelText('Answer');
    expect(input).toHaveAttribute('type', 'text');
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: 'ada' } });
    fireEvent.submit(input.closest('form')!);
    expect(authAnswer).toHaveBeenLastCalledWith(6, 'ada');
    act(() => useOps.getState().apply({ type: 'authResolved', prompt: 6 }));
    expect(screen.queryByRole('dialog')).toBeNull();
    ask(7, "Password for 'https://ada@h': ", true);
    expect(screen.getByLabelText('Password')).toHaveValue('');
  });

  it('owns the keyboard while open: the app layer behind it sees no key (ruling R6)', () => {
    const app = vi.fn(() => 'handled' as const);
    const off = registerKeys('app', app);
    render(<AuthModal />);
    ask(8, 'Passphrase: ', true);
    const input = screen.getByLabelText('Password');
    for (const key of ['Escape', 'w', 'F7', 'ArrowDown']) fireEvent.keyDown(input, { key, ctrlKey: key === 'w' });
    expect(app).not.toHaveBeenCalled();
    act(() => useOps.getState().apply({ type: 'authResolved', prompt: 8 }));
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(app).toHaveBeenCalledTimes(1);
    off();
  });

  it('opening closes an open context menu and picker, so nothing else shares the menu layer\'s keys', () => {
    const onClose = vi.fn();
    render(
      <>
        <AuthModal />
        <RefPicker anchor={new DOMRect(0, 0, 10, 10)} items={[{ id: 'a', label: 'a' }]} placeholder="Find" onPick={() => {}} onClose={onClose} />
      </>,
    );
    act(() => useMenu.getState().show([{ kind: 'action', id: 'x', label: 'X', icon: KeyRound, tooltip: 't', run: () => {} }], 0, 0));
    ask(10, 'Username: ', false);
    expect(useMenu.getState().rows).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a prompt the backend no longer knows is dropped, so the modal never sticks', async () => {
    authAnswer.mockImplementation(async () => { throw { kind: 'NotFound', message: 'no such prompt' }; });
    render(<AuthModal />);
    ask(9, 'Username: ', false);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); });
    expect(authAnswer).toHaveBeenLastCalledWith(9, null);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
