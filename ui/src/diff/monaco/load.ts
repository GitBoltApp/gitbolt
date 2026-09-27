import type { MonacoHost } from './host';
import { memoizeUntilRejected } from './memo';

/** The only way UI code reaches Monaco: a dynamic import, so Monaco, Shiki and the Oniguruma
 * WASM load on the first diff and never in the graph's startup path (spec §10.3). It resolves
 * once the editor theme is defined, so no editor ever renders in Monaco's light default. */
export const loadMonacoHost: () => Promise<MonacoHost> = memoizeUntilRejected(() => import('./host').then((m) => m.createHost()));
