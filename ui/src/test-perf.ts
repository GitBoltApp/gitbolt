/** Load-proof performance checks for tests. The dev machine is power-capped and often runs many
 * builds at once: wall time swings 10x, and even this process's CPU time (the pool is `forks`)
 * grows 3-5x as the clock drops and SMT siblings compete. Absolute budgets fail under load, so
 * these checks assert growth instead: the cost at `factor`·n against the cost at n, both measured
 * in the same conditions, interleaved, best of several runs. A linear operation stays near
 * `factor`; a quadratic one goes to `factor`². */

/** This process's CPU time (user + system) spent in `fn`, in ms. */
export function cpuMs(fn: () => void): number {
  const t0 = process.cpuUsage();
  fn();
  const d = process.cpuUsage(t0);
  return (d.user + d.system) / 1000;
}

export interface Growth {
  /** Best CPU ms at n, and at factor·n. */
  small: number;
  large: number;
  /** large / small. */
  ratio: number;
}

/** The CPU clock's step, in ms: microseconds on Linux, but a 15.6 ms tick on Windows, where a
 * sub-millisecond job timed alone reads 0 (or a whole tick). Busy-waits one tick to measure it. */
function clockStepMs(): number {
  const used = (t0: NodeJS.CpuUsage) => { const d = process.cpuUsage(t0); return d.user + d.system; };
  let t0 = process.cpuUsage();
  while (used(t0) === 0); // to the next tick
  t0 = process.cpuUsage();
  let us = 0;
  while ((us = used(t0)) === 0);
  return us / 1000;
}
let step: number | undefined;

/** How a job's cost grows from size `n` to `factor`·n. `prepare(size)` builds the input (not
 * timed) and returns the timed work; it's called afresh for every run, so caches keyed on the
 * input don't carry over. One untimed warm-up run (the JIT, the regex engine), then `rounds`
 * interleaved samples, each size keeping its fastest. A sample's runs are timed together; while
 * the fastest at n lasts under `minMs` (or 5 steps of a coarse CPU clock), the samples are taken
 * again with more runs, so a sub-millisecond job isn't all noise. */
export function growth(prepare: (size: number) => () => void, n: number, { factor = 4, rounds = 2, minMs = 10 } = {}): Growth {
  step ??= clockStepMs();
  const floor = Math.max(minMs, 5 * step);
  const sample = (size: number, reps: number) => {
    const jobs = Array.from({ length: reps }, () => prepare(size));
    return cpuMs(() => { for (const job of jobs) job(); });
  };
  prepare(n)();
  for (let reps = 1; ; ) {
    let small = Infinity;
    let large = Infinity;
    for (let r = 0; r < rounds; r++) {
      small = Math.min(small, sample(n, reps));
      large = Math.min(large, sample(n * factor, reps));
    }
    if (small >= floor || reps >= 4096) return { small, large, ratio: large / Math.max(small, 0.001) };
    reps = Math.min(4096, reps * Math.max(2, Math.ceil(floor / Math.max(small, step))));
  }
}
