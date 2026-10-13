// The wasm-bindgen glue `just demo-wasm` writes to src/demo/wasm/ (git-ignored), aliased to this
// name in vite.config.ts; declared here so `tsc` passes before it's built. Matches
// crates/gitbolt-graph-wasm's exports.
declare module 'gitbolt-graph-wasm' {
  export default function init(opts: { module_or_path: BufferSource | WebAssembly.Module }): Promise<unknown>;
  export class GraphEngine {
    constructor();
    free(): void;
    addCommits(commitsJson: string): number;
    build(requestJson: string): string;
    walkOrder(requestJson: string): string;
    readonly size: number;
  }
}
