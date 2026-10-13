/** Where a fixture folder's top-level piece lives in the demo's file system (`demoRoot` in
 * ui/scripts/pack-demo.mjs and `golden::demo_root` in the harness say the same). */
export function demoRoot(name: string, piece: string): string {
  if (piece === 'repo') return `/demo/${name}`;
  if (piece === 'origin.git') return `/demo/.origins/${name}.git`;
  return `/demo/.extra/${name}/${piece}`;
}

/** A bundle file's place in the demo (`rel` is relative to the fixture folder). */
export function demoPath(name: string, rel: string): string {
  const i = rel.indexOf('/');
  return i < 0 ? demoRoot(name, rel) : demoRoot(name, rel.slice(0, i)) + rel.slice(i);
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}
