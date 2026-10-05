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

/** How a job's cost grows from size `n` to `factor`·n. `prepare(size)` builds the input (not
 * timed) and returns the timed work; it's called afresh for every run, so caches keyed on the
 * input don't carry over. One untimed warm-up run (the JIT, the regex engine), then one run at n
 * sets how many runs make one sample (at least `minMs` at n), so a sub-millisecond job isn't all
 * noise. Then `rounds` interleaved samples; each size keeps its fastest. */
export function growth(prepare: (size: number) => () => void, n: number, { factor = 4, rounds = 2, minMs = 10 } = {}): Growth {
  prepare(n)();
  const reps = Math.min(1000, Math.ceil(minMs / Math.max(cpuMs(prepare(n)), 0.01)));
  const sample = (size: number) => { let ms = 0; for (let k = 0; k < reps; k++) ms += cpuMs(prepare(size)); return ms; };
  let small = Infinity;
  let large = Infinity;
  for (let r = 0; r < rounds; r++) {
    small = Math.min(small, sample(n));
    large = Math.min(large, sample(n * factor));
  }
  return { small, large, ratio: large / Math.max(small, 0.001) };
}
