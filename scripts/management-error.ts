/** Describe download failures without echoing URLs, response bodies or credential-bearing causes. */
export function managementError(error: unknown): string {
  const e = error as Error & { code?: string; cause?: any };
  if (e?.name === 'TypeError' && ['UND_ERR_SOCKET', 'ECONNRESET'].includes(e?.cause?.code))
    return '下载连接中断。请检查网络或代理是否稳定，然后重试。';
  const messages: Record<string, string> = {
    GITHUB_RELEASE_OR_ASSET_NOT_FOUND:
      '找不到指定版本或安装包。请检查版本号，或执行 dooknow update 获取最新版本。',
    GITHUB_NO_PUBLISHED_RELEASE: '仓库中尚无可更新的已发布版本，请稍后重试。',
    GITHUB_RATE_LIMITED: 'GitHub 请求过于频繁，已触发限流。请稍后重试。',
    GITHUB_ACCESS_DENIED: 'GitHub 拒绝访问。请检查网络代理；私有仓库还需检查下载凭据的权限。',
    GITHUB_AUTHENTICATION_FAILED: 'GitHub 下载凭据无效或已过期，请更新凭据后重试。',
    GITHUB_CREDENTIAL_UNAVAILABLE: '无法读取 GitHub 下载凭据，请检查凭据文件是否存在及其访问权限。',
    GITHUB_REPOSITORY_MISMATCH: '下载源与配置的 GitHub 仓库不一致，请检查安装源配置。',
    GITHUB_ASSET_REDIRECT_REJECTED: '下载地址跳转异常，已停止下载。请检查代理或安装源后重试。',
    INVALID_GITHUB_METADATA: 'GitHub 返回的版本信息无法识别，请稍后重试。',
    GITHUB_METADATA_TOO_LARGE: 'GitHub 返回的版本信息超出限制，已停止下载。',
    GITHUB_TOO_MANY_RELEASES: '发布版本过多，无法确定最新版本。请用 --version 指定版本。',
    INVALID_RELEASE_VERSION: '版本号格式不正确，例如：dooknow update --version 1.1.0-rc.12。',
  };
  if (messages[e?.message]) return messages[e.message];
  if (
    e?.message === 'GITHUB_DOWNLOAD_FAILED' ||
    e?.message === 'fetch failed' ||
    e?.name === 'TimeoutError'
  ) {
    const codes = new Set([
      e?.code,
      e?.cause?.code,
      ...(e?.cause?.errors || []).map((v: any) => v.code),
    ]);
    if (
      e?.name === 'TimeoutError' ||
      codes.has('ETIMEDOUT') ||
      codes.has('UND_ERR_CONNECT_TIMEOUT')
    )
      return '下载连接超时。请检查网络或代理是否可用，然后重试。';
    if (codes.has('ENOTFOUND') || codes.has('EAI_AGAIN'))
      return '无法解析下载服务器或代理的域名。请检查网络、DNS 和代理设置，然后重试。';
    if (codes.has('ECONNREFUSED'))
      return '无法连接下载服务器或代理。请确认代理已启动、地址和端口正确，然后重试。';
    return '下载失败，无法连接 GitHub。请检查网络；需要代理时设置 HTTPS_PROXY 后重试，DooKnow 会自动使用代理。';
  }
  if (/^GITHUB_HTTP_\d+$/.test(e?.message || ''))
    return 'GitHub 下载服务暂时不可用（HTTP ' + e.message.slice(12) + '），请稍后重试。';
  return e?.message || '操作失败，请检查配置后重试。';
}
