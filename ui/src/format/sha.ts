/** The one short-SHA length, app-wide (feedback H15): the graph's SHA column at its default
 * width, the details header and the compare header show this many hex characters. Any new
 * place that shows a short hash uses it too. */
export const SHORT_SHA_LEN = 6;

/** A commit id cut to SHORT_SHA_LEN characters. */
export const shortSha = (id: string): string => id.slice(0, SHORT_SHA_LEN);
