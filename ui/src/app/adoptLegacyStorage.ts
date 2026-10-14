// main.tsx's first import: GitBolt's localStorage keys take GitVolt's names before any module reads them.
import { adoptLegacyKeys } from './legacyStorage';

try {
  adoptLegacyKeys(window.localStorage);
} catch {
  // No storage, or it's full: the UI starts from its defaults, as on a first run.
}
