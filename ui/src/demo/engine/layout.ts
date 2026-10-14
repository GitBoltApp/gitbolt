// The graph pipeline as the demo uses it: crates/gitvolt-graph through gitvolt-graph-wasm
// (engine/graph.ts loads it). One per repository: a store of commits, and the build.
import type { GraphPayload } from '../../api/gen/GraphPayload';
import type { CommitIn } from '../gen/CommitIn';
import type { GraphRequest } from '../gen/GraphRequest';

export interface GraphLayout {
  /** Adds the commits it doesn't hold yet; how many. */
  addCommits(commits: CommitIn[]): number;
  build(request: GraphRequest): GraphPayload;
  /** The commit ids the build's walk collects, in collection order (`gitvolt_graph::walk_order`). */
  walkOrder(request: GraphRequest): string[];
}

export type GraphFactory = () => GraphLayout;
