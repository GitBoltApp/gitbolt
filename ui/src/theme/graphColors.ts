import { THEMES } from './themes';

/** Default Dark's lane colors, lanes 0–9 (spec §8.2), which are also the app
 * icon's palette. Themed code reads `useTheme().colors.graph` instead. */
export const GRAPH_COLORS: readonly string[] = THEMES['default-dark'].graph;
