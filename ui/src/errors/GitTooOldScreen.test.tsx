import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

const appInfo = vi.hoisted(() => vi.fn());
vi.mock('../api/client', () => ({ api: { appInfo } }));
import { GitTooOldScreen } from './GitTooOldScreen';
import { useGitCheck } from './gitCheck';

const tooOld = { kind: 'GitTooOld', message: 'git 2.25.1 is too old; GitBolt needs 2.40 or newer', commandId: 1, stderr: null } as const;

it('explains the minimum and offers Retry', () => {
  render(<GitTooOldScreen error={tooOld} />);
  expect(screen.getByRole('alertdialog').textContent).toContain('GitBolt needs git 2.40 or newer');
  expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
});

vi.spyOn(console, 'warn').mockImplementation(() => {});
it('check() blocks on GitTooOld and git-not-found, ignores other errors, and clears when git is fine', async () => {
  appInfo.mockRejectedValueOnce(tooOld);
  await useGitCheck.getState().check();
  expect(useGitCheck.getState().problem?.kind).toBe('GitTooOld');
  appInfo.mockResolvedValueOnce({ appVersion: 'x', gitVersion: '2.47.1' });
  await useGitCheck.getState().check();
  expect(useGitCheck.getState().problem).toBeNull();
  appInfo.mockRejectedValueOnce({ kind: 'Io', message: 'failed to run git: No such file or directory (os error 2)', commandId: 2, stderr: null });
  await useGitCheck.getState().check();
  expect(useGitCheck.getState().problem?.kind).toBe('Io');
  useGitCheck.setState({ problem: null });
  appInfo.mockRejectedValueOnce({ kind: 'Io', message: 'failed to run git: Permission denied (os error 13)', commandId: 3, stderr: null });
  await useGitCheck.getState().check();
  expect(useGitCheck.getState().problem).toBeNull();
  useGitCheck.setState({ problem: null });
  appInfo.mockRejectedValueOnce(new Error('transport'));
  await useGitCheck.getState().check();
  expect(useGitCheck.getState().problem).toBeNull();
});
