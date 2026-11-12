export function installSummary(config: {
  host?: string;
  port?: number;
  origin: string;
  allowedOrigins?: string[];
  serviceManaged?: boolean;
}) {
  const host = config.host || '127.0.0.1';
  const port = config.port || 5173;
  const addresses = [...new Set([config.origin, ...(config.allowedOrigins || [])])];
  const local = host === 'localhost' || host.startsWith('127.') || host === '::1';
  const listener = host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
  return [
    '',
    'DooKnow 安装完成',
    '────────────────────────────────────────',
    '',
    '访问地址（以下地址均已允许登录）',
    ...addresses.map((address) => `  ${address}`),
    '',
    '网络监听',
    `  监听地址：${listener}`,
    ...(local ? ['  当前仅允许本机连接；其他设备需配置监听地址或反向代理。'] : []),
    '  实际可达性取决于网络和防火墙。',
    ...(host === '::' ? ['  IPv4 是否可用取决于系统双栈设置，此处仅配置 IPv6 地址。'] : []),
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
