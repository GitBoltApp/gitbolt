/** A stash row's label: git's default "On <branch>: " / "WIP on <branch>: " prefix is split off
 * the message, so the row reads "Experiment" with the branch as dim secondary text. A custom
 * message without that prefix is shown whole. */
export function stashLabel(message: string): { text: string; branch: string | null } {
  const m = /^(?:WIP on|On) ([^:]+): (.*)$/s.exec(message);
  return m ? { text: m[2] || message, branch: m[1] } : { text: message, branch: null };
}
