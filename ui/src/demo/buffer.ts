// isomorphic-git reaches for Node's Buffer as a global: installed before anything imports it.
import { Buffer } from 'buffer';

(globalThis as { Buffer?: unknown }).Buffer ??= Buffer;
