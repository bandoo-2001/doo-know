import { networkInterfaces } from 'node:os';

// Prefer physical LAN interfaces over VPN and container networks for the login URL.
export function installNetwork(
  options: { host?: string; port?: string; origin?: string },
  interfaces = networkInterfaces(),
) {
  const host = options.host || '0.0.0.0';
  const port = Number(options.port || 5173);
  const family = host === '::' ? 'IPv6' : 'IPv4';
  const candidates = Object.entries(interfaces)
    .flatMap(([name, entries]) =>
      (entries || [])
        .filter(
          (entry) =>
            !entry.internal &&
            entry.family === family &&
            !entry.address.startsWith('169.254.') &&
            !entry.address.startsWith('fe80:'),
        )
        .map((entry) => ({
          address: entry.address,
          virtual: /^(docker|veth|br-|virbr|tailscale|tun|tap|wg)/.test(name),
        })),
    )
    .sort((a, b) => Number(a.virtual) - Number(b.virtual));
  const address =
    host === '0.0.0.0' || host === '::'
      ? candidates[0]?.address || (host === '::' ? '::1' : '127.0.0.1')
      : host;
  const urlHost = address.includes(':') ? `[${address.replace('%', '%25')}]` : address;
  return { host, port, origin: options.origin || `http://${urlHost}:${port}` };
}
