# 私有 GitHub 安装与发布

DooKnow 源码、安装脚本及发行包保存在同一个私有仓库。源码维护 `deploy/install.sh`，GitHub Releases 保存构建后的安装器、应用、MCP/Git、可选检索包和校验清单。仓库中的 `deploy/github-install.sh` 是发布后生成的固定版本入口，包含安装器的 asset ID 与 SHA-256，不包含凭据。

## 准备下载凭据

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

## 一行安装

curl：

```bash
curl -q --config "${XDG_CONFIG_HOME:-$HOME/.config}/doo-know/secrets/github.curl" -fsS --max-redirs 0 'https://api.github.com/repos/bandoo-2001/doo-know/contents/deploy/github-install.sh?ref=txj%2Fdoo-know-platform' | bash
```

wget：

```bash
wget --no-config --no-netrc --config "${XDG_CONFIG_HOME:-$HOME/.config}/doo-know/secrets/github.wget" --max-redirect=0 -qO- 'https://api.github.com/repos/bandoo-2001/doo-know/contents/deploy/github-install.sh?ref=txj%2Fdoo-know-platform' | bash
```

入口通过 GitHub Contents API 返回仓库中的原始脚本，随后按固定 asset ID 下载并校验实际发行安装器。所有安装效果位于完整脚本的 `main` 中；初始下载中断不会执行部分安装。无终端时仍不会创建空密码账号。

发行安装器自带 Node、应用和生产依赖，服务器不需要 gh、jq、全局 Node/Python、编译器、Docker 或 sudo。普通 HTTPS 自有制品源与本机验收源继续兼容。[完整安装与恢复](原生安装与恢复.md)

## 升级、插件与检索

原生配置只保存分发仓库和凭据文件引用，浏览器不会获得 Token。升级、官方插件和检索包共用认证下载器；凭据仅发往指定仓库的 `api.github.com`，302 跳转校验 GitHub 制品存储域名后重新发起无认证请求，禁止后续跳转。curl/wget 同样分开请求，并忽略用户级下载工具配置。

```bash
# RC 必须显式指定版本；不指定时查询 GitHub 最新正式版本。
dooknow update --version 1.1.0-rc.3
```

旧安装重复执行上方安装入口，会使用已校验的新管理程序接管升级；保留原账号、配置、原文与数据。新版本仍执行维护闸门、一致性备份、迁移、健康检查与失败恢复，不绕过既有升级规则。GitHub 下载授权不替代 MCP 的 OAuth 或 Tunnel 授权。

恢复到空目录后需重新配置 GitHub 下载凭据；发布凭据不进入应用发行包或知识库。401、权限不足、发布/附件缺失或校验失败时停止下载，平台的已有笔记功能仍可使用。

## 开发者发布

在干净的已推送源码版本上构建。以下命令的令牌参数只有受控文件路径，不能传 Token 值：

```bash
node scripts/release.mjs --output .local/github-rc3 \
  --base-url 'https://github.com/bandoo-2001/doo-know/releases/download/v1.1.0-rc.3' \
  --version 1.1.0-rc.3
node --import tsx scripts/publish-github.ts \
  --directory .local/github-rc3 --repository bandoo-2001/doo-know \
  --tag v1.1.0-rc.3 --commit '<构建元数据中的完整提交 SHA>' \
  --token-file '/受控位置/github-publish.token' --bootstrap deploy/github-install.sh
```

发布器只接受私有仓库和预期制品，验证本地摘要、Git 标签对应提交与已存在附件的远端 SHA-256。先创建草稿，上传全部附件并绑定实际 asset ID，最后发布；RC 标记 prerelease，不冒充最新正式版本。重试沿用相同标签与附件，内容冲突时停止，不覆盖已发布制品或移动标签。完成后提交并推送生成的入口与文档。可受控使用 `--token-fd` 由父进程传入现有发布连接，值不进入参数、日志或环境变量。

发布失败保留草稿及已上传附件用于核对；已有正常安装不受影响。远端发布流程遵循 [GitHub Release API](https://docs.github.com/en/rest/releases/releases#create-a-release) 与[附件下载/上传接口](https://docs.github.com/en/rest/releases/assets)。
