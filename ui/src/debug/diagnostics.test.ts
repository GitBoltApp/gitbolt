import { beforeEach, expect, it, vi } from 'vitest';

const diagnostics = vi.hoisted(() => vi.fn(async () => 'GitBolt 0.1.0\n'));
const openLogsFolder = vi.hoisted(() => vi.fn(async () => null));
const copyText = vi.hoisted(() => vi.fn(async (_t: string) => {}));
vi.mock('../api/client', () => ({ api: { diagnostics, openLogsFolder }, errorMessage: String, onEvent: () => () => {} }));
vi.mock('../api/transport', () => ({ copyText, inTauri: () => false }));

const { copyDiagnostics, openLogsFolder: open } = await import('./diagnostics');
const { useAppState } = await import('../app/state');
const { useToast } = await import('../ui/toast');

beforeEach(() => vi.clearAllMocks());

it('asks the backend for the text with the UI facts, copies it and says so (T9, R24)', async () => {
  await copyDiagnostics();
  expect(diagnostics).toHaveBeenCalledWith({ userAgent: navigator.userAgent, settings: useAppState.getState().settings });
  expect(copyText).toHaveBeenCalledWith('GitBolt 0.1.0\n');
  expect(useToast.getState().message).toBe('Diagnostics copied');
});

it('a refused copy is a failure, for the caller to report', async () => {
  copyText.mockRejectedValueOnce(new Error('denied'));
  await expect(copyDiagnostics()).rejects.toThrow('denied');
});

it('opens the logs folder through the backend', async () => {
  await open();
  expect(openLogsFolder).toHaveBeenCalledOnce();
});
