// @vitest-environment happy-dom
import { expect, test, vi } from 'vitest';
import { createTransport, setTransportOverride, type Transport } from './transport';

test('an installed override is the transport (the website demo), timed like the others', async () => {
  const call = vi.fn(async () => 'answer');
  const fake: Transport = { call, subscribe: () => () => {} };
  setTransportOverride(fake);
  expect(await createTransport().call({ method: 'appInfo' })).toBe('answer');
  expect(call).toHaveBeenCalledWith({ method: 'appInfo' });
});
