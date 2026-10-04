/** `host` without its `:port`, lowercased. An account on `h:8443` gives its projects the host
 * `h:8443`, while a remote's host comes port-less from its URL (IPv6 is out of scope). */
export const hostName = (host: string | null | undefined) => (host ?? '').replace(/:\d+$/, '').toLowerCase();

/** Whether remote `r` points at the project `host`/`path`: host names without the port, the path
 * case-insensitively. */
export const remoteIsProject = (r: { host: string | null; path: string | null }, host: string, path: string | null | undefined) =>
  hostName(r.host) === hostName(host) && (r.path ?? '').toLowerCase() === (path ?? '').toLowerCase();
