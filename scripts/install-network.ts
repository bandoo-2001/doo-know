import { networkInterfaces } from 'node:os';

function addressOrigin(address: string, port: number) {
  const host = address.includes(':') ? `[${address}]` : address;
  return `http://${host}:${port}`;
}

// Prefer physical LAN interfaces over VPN and container networks for the primary URL.
export function installNetwork(
  options: { host?: string; port?: string; origin?: string },
  interfaces = networkInterfaces(),
) {
  const host = options.host || '0.0.0.0';
  const port = Number(options.port || 5173);
  const family = host === '::' ? 'IPv6' : 'IPv4';
  const entries = Object.entries(interfaces).flatMap(([name, addresses]) =>
    (addresses || [])
      .filter(
        (entry) =>
          entry.family === family &&
          !entry.address.startsWith('169.254.') &&
          !/^fe[89ab]/i.test(entry.address) &&
          !entry.address.includes('%'),
      )
      .map((entry) => ({
        address: entry.address,
        internal: entry.internal,
        virtual: /^(docker|veth|br-|virbr|tailscale|tun|tap|wg)/.test(name),
      })),
  );
  const candidates = entries
    .filter((entry) => !entry.internal)
    .sort((a, b) => Number(a.virtual) - Number(b.virtual));
  const wildcard = host === '0.0.0.0' || host === '::';
  const address = wildcard ? candidates[0]?.address || (host === '::' ? '::1' : '127.0.0.1') : host;
  const origin = options.origin || addressOrigin(address, port);
  // HTTPS is normally terminated by a reverse proxy. Do not advertise HTTPS on
  // the plain HTTP listener or issue secure-cookie sessions over HTTP aliases.
  const aliases =
    new URL(origin).protocol === 'http:'
      ? wildcard
        ? [
            ...entries.map((entry) => entry.address),
            host === '::' ? '::1' : '127.0.0.1',
            'localhost',
          ]
        : [host]
      : [];
  const allowedOrigins = [
    ...new Set([origin, ...aliases.map((alias) => addressOrigin(alias, port))]),
  ];
  return { host, port, origin, allowedOrigins, autoAllowedOrigins: true };
}
