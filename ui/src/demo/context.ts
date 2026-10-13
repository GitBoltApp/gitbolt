// What every demo handler gets besides its params.
import type { AppEvent } from '../api/gen/AppEvent';
import type { DemoRepos } from './engine/repos';
import type { DemoState } from './engine/state';

export interface DemoContext {
  /** By repo id; `open`/`locate` load them from their bundles. */
  repos: DemoRepos;
  /** Settings, profile, watched repos: in memory. */
  state: DemoState;
  /** To every subscriber, asynchronously. */
  emit(ev: AppEvent): void;
  /** Throws the GbError `{ kind: 'Other', message: 'Not in the demo: <what>' }`. */
  notInDemo(what: string): never;
}
