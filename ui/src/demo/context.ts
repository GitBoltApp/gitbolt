// What every demo handler gets besides its params.
import type { AppEvent } from '../api/gen/AppEvent';
import type { DemoRepos } from './engine/repos';
import type { DemoState } from './engine/state';
import type { DemoWrites } from './engine/write/state';

/** The demo's time: commits, tags, stashes and the journal are stamped with it. The browser's in the
 *  demo; fixed in tests and the parity suite, so their objects' ids are the core's. */
export interface DemoClock {
  nowMs(): number;
  /** Minutes east of UTC (+0200 is 120). */
  tzOffsetMinutes(): number;
}

export interface DemoContext {
  /** By repo id; `open`/`locate` load them from their bundles. */
  repos: DemoRepos;
  /** Settings, profile, watched repos: in memory. */
  state: DemoState;
  /** To every subscriber, asynchronously. */
  emit(ev: AppEvent): void;
  /** Throws the GbError `{ kind: 'Other', message: 'Not in the demo: <what>' }`. */
  notInDemo(what: string): never;
  /** Commits, stashes and the journal are stamped with it. */
  clock: DemoClock;
  /** The journals, staging logs and queues (plan 3's writes). */
  writes: DemoWrites;
}
