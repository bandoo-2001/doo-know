import { networkInterfaces } from 'node:os';

export function installSummary(
  config: { host?: string; port?: number; origin: string; serviceManaged?: boolean },
  interfaces = networkInterfaces(),
) {
  const host = config.host || '127.0.0.1';
  const port = config.port || 5173;
  const wildcard = host === '0.0.0.0' || host === '::';
  const hosts = wildcard
    ? Object.values(interfaces).flatMap((entries) =>
        (entries || [])
          .filter((entry) => (host === '::' ? entry.family === 'IPv6' : entry.family === 'IPv4'))
          .map((entry) => entry.address),
      )
    : [host];
  const addresses = [...new Set(hosts)].map(
    (address) =>
      `  http://${address.includes(':') ? `[${address.replace('%', '%25')}]` : address}:${port}`,
  );
  const local = host === 'localhost' || host.startsWith('127.') || host === '::1';
  return [
    '',
    'DooKnow 安装完成',
    '────────────────────────────────────────',
    '',
    '访问地址',
    `  配置地址：${config.origin}`,
    `  监听地址：${host}:${port}`,
    ...addresses,
    ...(local ? ['  当前仅允许本机连接；其他设备需配置监听地址、访问来源或反向代理。'] : []),
    ...(wildcard
      ? [
          '  以上按本机网卡列出；实际可达性取决于网络和防火墙。',
          '  登录及写入请求需使用配置地址；通过其他地址访问前请配置对应访问来源。',
          ...(host === '::' ? ['  IPv4 是否可用取决于系统双栈设置，此处仅列出 IPv6 地址。'] : []),
        ]
      : []),
    '',
    '下一步',
    '  登录后选择服务器知识库目录。',
    '',
    '服务管理',
    config.serviceManaged === false
      ? '  前台运行：dooknow serve'
      : '  dooknow status / start / stop / restart / doctor',
    '',
  ].join('\n');
}
