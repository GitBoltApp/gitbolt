const started = new Map<string, number>();

/** Interaction timings for the budgets in spec §17.3 (Task 14 reads these console lines). */
export const perf = {
  start(name: string): void {
    started.set(name, performance.now());
  },
  /** Logs `[gitbolt] <name> ready in N ms` after the next paint, once per `start`. */
  done(name: string): void {
    const t0 = started.get(name);
    if (t0 === undefined) return;
    started.delete(name);
    requestAnimationFrame(() => console.info(`[gitbolt] ${name} ready in ${Math.round(performance.now() - t0)} ms`));
  },
};
