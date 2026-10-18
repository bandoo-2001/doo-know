/** Node 22 reads proxy variables only when its proxy support is enabled at startup. */
export async function withEnvironmentProxy(work: () => Promise<void>) {
  const proxy = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'].some((k) =>
    process.env[k]?.trim(),
  );
  if (!proxy || process.execArgv.includes('--use-env-proxy')) return work();
  if (!process.allowedNodeEnvironmentFlags.has('--use-env-proxy'))
    throw Error('当前 Node 不支持自动代理，请使用安装包自带的 Node 运行 DooKnow。');
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  // An empty lowercase variable would otherwise shadow a configured uppercase one.
  for (const key of [
    'http_proxy',
    'https_proxy',
    'no_proxy',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
  ])
    if (!env[key]?.trim()) delete env[key];
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) {
    if (!env[key]) continue;
    try {
      const url = new URL(env[key]);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        !url.hostname ||
        url.hash ||
        /[\r\n]/.test(env[key])
      )
        throw Error();
    } catch {
      throw Error(
        '代理地址格式不正确，请检查 HTTP_PROXY / HTTPS_PROXY，使用 http://主机:端口 或 https://主机:端口。',
      );
    }
  }
  if (!process.execve)
    throw Error('当前 Node 不支持自动代理，请使用安装包自带的 Node 运行 DooKnow。');
  // Replace this process so systemd keeps the same PID and graceful shutdown signals are not duplicated.
  process.execve(
    process.execPath,
    [process.execPath, '--use-env-proxy', ...process.execArgv, ...process.argv.slice(1)],
    env,
  );
}
