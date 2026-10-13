// Types for pack-demo.mjs, so TypeScript tests can import it.
export const MAGIC: string;
export const MARKER: string;
export function demoRoot(name: string, piece: string): string;
export function rewritePaths(text: string, root: string, name: string, pieces: string[]): string;
export function rewriteAlternates(text: string, gitDirRel: string, root: string, name: string, pieces: string[]): string;
export function encodeBundle(name: string, files: { path: string; mode: number; data: Uint8Array }[]): Buffer;
export function indexVersion(buf: Uint8Array): number | null;
export function packFixture(dir: string, name: string, opts?: { inPlace?: boolean }): Buffer;
export function scrubIndexStat(buf: Uint8Array): Buffer;
