/** Node 22 reads proxy variables only when its proxy support is enabled at startup. */
export async function withEnvironmentProxy(
  work: () => Promise<void>,
  fallback?: () => NodeJS.ProcessEnv | undefined | Promise<NodeJS.ProcessEnv | undefined>,
) {
  const proxyKeys = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'];
  const proxy = proxyKeys.some((k) => process.env[k]?.trim());
  const extra = !proxy && fallback ? await fallback() : undefined;
  const env = Object.fromEntries(
    Object.entries({ ...process.env, ...extra }).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  if (!proxyKeys.some((key) => env[key]?.trim())) return work();
  if (env.NO_PROXY === undefined && env.no_proxy === undefined)
    env.NO_PROXY = 'localhost,127.0.0.1,::1';
  // An empty lowercase variable would otherwise shadow a configured uppercase one.
  for (const key of proxyKeys) if (!env[key]?.trim()) delete env[key];
  if (!env.no_proxy?.trim() && env.NO_PROXY?.trim()) delete env.no_proxy;
  if (!env.NO_PROXY?.trim() && env.no_proxy?.trim()) delete env.NO_PROXY;
  const changed = [...new Set([...Object.keys(env), ...Object.keys(process.env)])].some(
    (key) => env[key] !== process.env[key],
  );
  if (!changed && process.execArgv.includes('--use-env-proxy')) return work();
  if (!process.allowedNodeEnvironmentFlags.has('--use-env-proxy'))
    throw Error('当前 Node 不支持自动代理，请使用安装包自带的 Node 运行 DooKnow。');
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
    [
      process.execPath,
      ...(!process.execArgv.includes('--use-env-proxy') ? ['--use-env-proxy'] : []),
      ...process.execArgv,
      ...process.argv.slice(1),
    ],
    env,
  );
}
