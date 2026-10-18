# GitHub 安装与发布

DooKnow 源码及发行包已公开，默认匿名下载，安装、官方插件、检索包和升级均不需要 GitHub Token。安装器仍校验固定版本、SHA-256、归档路径和运行时，跳转仅允许GitHub制品存储域名。

## 一行安装

在Linux x86_64主机上以普通用户执行：

```bash
curl -fsSL 'https://raw.githubusercontent.com/bandoo-2001/doo-know/txj/doo-know-platform/deploy/github-install.sh' | bash
```

或：

```bash
wget -qO- 'https://raw.githubusercontent.com/bandoo-2001/doo-know/txj/doo-know-platform/deploy/github-install.sh' | bash
```

入口固定到1.1.0-rc.15。安装器包含Node及生产依赖，无需现场npm编译、Docker或sudo；需要可用的systemd用户会话。初始用户名、隐藏密码在终端输入，登录Web后自己选择服务器知识库目录，再配置插件与检索。

Mini主机若继续使用原域名，可直接执行：

```bash
curl -fsSL 'https://raw.githubusercontent.com/bandoo-2001/doo-know/txj/doo-know-platform/deploy/github-install.sh' | DOOKNOW_APP_ORIGIN='https://know.mini.bandoo.top' bash
```

默认监听127.0.0.1:5173，远程访问另需正确的域名转发；完整目录、账号、备份和安装参数见[原生安装与恢复](原生安装与恢复.md)。重复安装保留已有账号及数据。

## 升级与下载

执行 `dooknow update` 默认查询 GitHub 已发布版本，按版本号选取最新版本，包含 RC、排除草稿；自动发现使用 GitHub API，若触发限流会提示稍后重试。指定版本可跳过版本发现。公开安装包下载直接读取 Release 附件，不读取旧的本地下载 Token，仍逐项校验版本与 SHA-256：

```bash
dooknow update
# 如需指定版本
dooknow update --version 1.1.0-rc.15
```

旧安装重新运行公开入口会将分发配置切为匿名模式。需要继续使用私有分发时，安装前显式设置下方凭据文件环境变量。GitHub下载授权与MCP的OAuth/Tunnel授权相互独立。

## 需要网络代理时

curl/wget 沿用当前代理环境。从 rc.12 起，`dooknow` 管理命令和通过 `serve` 启动的后台下载会自动使用已有 `HTTPS_PROXY` / `HTTP_PROXY`（也支持小写形式），无需设置 `NODE_OPTIONS`。`NO_PROXY` 应包含 `127.0.0.1,localhost,::1`，本机请求会绕过代理。普通直连网络无需设置。不会自动扫描端口或改动系统代理。

systemd 用户服务不会自动继承安装终端的环境。可在 `~/.config/systemd/user/doo-know.service.d/proxy.conf` 为本服务单独配置：

```ini
[Service]
EnvironmentFile=%h/.config/doo-know/proxy.env
```

在上述 `proxy.env` 中填写实际代理环境，文件权限设为 600；代理若含认证，不写进仓库或 unit。更新配置后执行 `systemctl --user daemon-reload` 和 `dooknow restart`。显式选择前台模式时，设置代理环境后直接运行 `dooknow serve`。本次私有检索包的下载与准备验收使用了这一网络配置；没有修改主机全局代理。

## 可选：私有分发凭据

在 GitHub 创建限定 `bandoo-2001/doo-know` 的 fine-grained PAT，授予 **Contents: read**。此权限也能读取该私有仓库源码，不能作为仅下载附件的授权。发布凭据另需 Contents: write；安装端不需要写权限。[GitHub 附件权限说明](https://docs.github.com/en/rest/releases/assets#get-a-release-asset)

在待安装服务器的 Bash 中执行以下一次性初始化，隐藏输入 Token；凭据仅写入用户自己的配置目录，不放入 URL、仓库或命令参数：

```bash
(
  set +x
  set -euo pipefail
  umask 077
  config="${XDG_CONFIG_HOME:-$HOME/.config}/doo-know/secrets"
  install -d -m 700 "$config"
  read -r -s -p 'GitHub 下载 Token: ' token </dev/tty
  printf '\n'
  [[ "$token" =~ ^[A-Za-z0-9_-]{20,4096}$ ]] || exit 1
  printf '%s\n' "$token" > "$config/github.token"
  printf 'header = "Authorization: Bearer %s"\nheader = "Accept: application/vnd.github.raw+json"\n' "$token" > "$config/github.curl"
  printf 'header = Authorization: Bearer %s\nheader = Accept: application/vnd.github.raw+json\n' "$token" > "$config/github.wget"
  chmod 600 "$config/github.token" "$config/github.curl" "$config/github.wget"
)
```

这一步也用于轮换过期的下载凭据；运行中的平台在下一次下载时重新读取文件。自动部署可事先提供受控的 `DOOKNOW_GITHUB_TOKEN_FILE`，无需通过环境变量传递 Token 本身。


私有下载必须显式选择凭据文件：

```bash
export DOOKNOW_GITHUB_TOKEN_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/doo-know/secrets/github.token"
```

未指定时使用公开匿名下载，不自动读取磁盘上遗留的Token。显式指定的文件缺失或不安全时停止，不自动回退匿名模式。
## 维护者发布

公开安装不需要Token；上传发行包仍需要维护者的写权限凭据。公开仓库发布必须显式加`--public`，否则保持原有私有仓库检查，避免意外公开上传。

```bash
node scripts/release.mjs --output .local/github-rc8 \
  --base-url 'https://github.com/bandoo-2001/doo-know/releases/download/v1.1.0-rc.8' \
  --version 1.1.0-rc.8
node --import tsx scripts/publish-github.ts --public \
  --directory .local/github-rc8 --repository bandoo-2001/doo-know \
  --tag v1.1.0-rc.8 --commit '<构建元数据中的完整提交SHA>' \
  --token-file '/受控位置/github-publish.token' --bootstrap deploy/github-install.sh
```

从干净且已推送的源码构建。先草稿上传附件、核对远端SHA-256并绑定固定asset ID，再发布；已有附件和标签不覆盖。生成入口后提交推送。认证参数只有受控文件路径或`--token-fd`，实际值不进URL、参数和日志。旧版本保留追溯，不将预发布候选标为最新正式版。
