import { describe, expect, it, vi } from 'vitest';

const createHost = vi.fn();
vi.mock('./host', () => ({ createHost }));

describe('loadMonacoHost', () => {
  it('loads the host once, but retries after a failed load instead of caching the failure', async () => {
    const host = { layout: vi.fn() };
    createHost.mockRejectedValueOnce(new Error('chunk failed')).mockResolvedValue(host);
    const { loadMonacoHost } = await import('./load');
    await expect(loadMonacoHost()).rejects.toThrow('chunk failed');
    await expect(loadMonacoHost()).resolves.toBe(host);
    await expect(loadMonacoHost()).resolves.toBe(host);
    expect(createHost).toHaveBeenCalledTimes(2);
  });
});
