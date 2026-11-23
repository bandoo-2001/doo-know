#!/usr/bin/env bash
# Generated pinned release bootstrap; contains no credentials.
main() {
  set +x
  set -euo pipefail
  umask 077
# Embedded into generated installers; no dependency on Node, Python, jq or gh.
dooknow_download_transport_error() {
  local stage="$1" client="$2" code="$3" details_file="${4:-}" cause
  case "$client:$code" in
    curl:5) cause='无法解析代理服务器地址，请核对代理主机名和 DNS。' ;;
    curl:6) cause='无法解析下载服务器地址，请检查 DNS。' ;;
    curl:7) cause='连接下载服务器失败，请检查网络、防火墙和代理。' ;;
    curl:18) cause='下载提前中断，请检查网络或代理连接后重试。' ;;
    curl:23|curl:26|wget:3) cause='无法读写下载文件，请检查目录权限、剩余空间和磁盘配额。' ;;
    curl:28) cause='下载超时，请检查网络和代理连通性后重试。' ;;
    curl:35|curl:59|curl:91) cause='TLS 握手失败，请检查代理及其 TLS 配置。' ;;
    curl:51|curl:58|curl:60|curl:77|curl:83|curl:90|wget:5)
      cause='TLS 证书校验失败，请检查系统时间、系统 CA 证书和代理的根证书。' ;;
    curl:47) cause='下载跳转异常，请检查发行地址与代理规则。' ;;
    curl:52|curl:55|curl:56)
      if [ -r "$details_file" ] && awk '/CONNECT.*407|response 407/ {found=1} END {exit !found}' "$details_file"; then
        cause='代理要求认证，请核对代理地址和凭据。'
      else
        cause='连接已中断或未返回数据，请检查网络和代理。'
      fi
      ;;
    curl:67|wget:6) cause='下载认证失败，请核对下载服务的访问权限。' ;;
    curl:97) cause='代理连接或认证失败，请核对代理地址、端口和凭据。' ;;
    wget:4)
      if [ -r "$details_file" ]; then
        cause="$(awk '
          /unable to resolve host|Name or service not known/ { print "无法解析下载服务器或代理地址，请检查 DNS 和代理主机名。"; exit }
          /timed out|Connection timeout/ { print "下载超时，请检查网络和代理连通性后重试。"; exit }
          /Connection refused|Network is unreachable/ { print "连接被拒绝或网络不可达，请检查网络、防火墙和代理。"; exit }
          /Connection reset|Read error|closed at byte/ { print "下载连接中断，请检查网络和代理后重试。"; exit }
          /Unable to establish SSL connection|TLS connection/ { print "TLS 握手失败，请检查代理及其 TLS 配置。"; exit }
        ' "$details_file")"
      else
        cause=''
      fi
      cause="${cause:-网络连接失败，请检查 DNS、网络和代理。}"
      ;;
    curl:2|curl:4|wget:2) cause='下载工具无法运行所需选项，请更新 curl 或 wget，或换用另一种工具。' ;;
    *) cause='下载工具异常，请检查网络、代理及工具版本后重试。' ;;
  esac
  printf '%s失败（%s 退出码 %s）。%s\n' "$stage" "$client" "$code" "$cause" >&2
}

github_fetch() (
  set +x
  set -euo pipefail
  umask 077
  local tool
  for tool in stat sleep awk mktemp dirname mv rm; do
    command -v "$tool" >/dev/null || { echo "GitHub 下载缺少必要命令 $tool，请安装系统工具后重试。" >&2; exit 1; }
  done
  local repository="$1" asset_id="$2" destination="$3" client="${4:-}"
  [[ "$repository" =~ ^[A-Za-z0-9-]+/[A-Za-z0-9_.-]+$ && "$asset_id" =~ ^[1-9][0-9]*$ ]] || {
    echo 'GitHub 发行信息中的仓库或制品编号无效，请从项目 README 重新获取安装命令。' >&2
    exit 1
  }
  local token_file="${DOOKNOW_GITHUB_TOKEN_FILE:-}" fd mode owner links token public_url="${5:-}"
  local github_work
  github_work="$(mktemp -d "$(dirname "$destination")/.github-download.XXXXXXXX" 2>/dev/null)" || {
    echo '无法创建 GitHub 下载临时目录，请检查目标目录权限、剩余空间和磁盘配额。' >&2
    exit 1
  }
  local progress_pid='' progress_started=$SECONDS
  progress_stop() {
    if [ -n "$progress_pid" ]; then
      kill "$progress_pid" 2>/dev/null || true
      wait "$progress_pid" 2>/dev/null || true
      progress_pid=''
      if [ "${1:-}" = failed ] && [ -t 2 ]; then printf '\n' >&2; fi
    fi
  }
  progress_line() {
    local bytes total elapsed
    bytes="$(stat -c %s "$github_work/asset" 2>/dev/null || echo 0)"
    total="$(awk '/^[[:space:]]*HTTP\// {ok=($2==200 || $2==206);n=0} ok && tolower($1)=="content-length:" {gsub(/\r/,"",$2);if($2 ~ /^[0-9]+$/)n=$2} END {print n+0}' "$github_work/headers" 2>/dev/null || echo 0)"
    elapsed=$((SECONDS-progress_started))
    awk -v b="$bytes" -v t="$total" -v e="$elapsed" -v done="${1:-0}" -v tty="$([ -t 2 ] && echo 1 || echo 0)" 'BEGIN {
      rate=e>0?b/e:0;p=t>0?int(b*100/t):0;if(p>99)p=99;
      prefix=done?"100%":(t>0?p"%":"总大小未知");
      eta=(t>b && rate>0)?sprintf("%.0f 秒",(t-b)/rate):"等待估算";
      printf "%s进度 %s | 已下载 %.2f MiB | 速度 %.2f MiB/s | 剩余 %s | 已用 %d 秒%s",tty?"\r":"",prefix,b/1048576,rate/1048576,eta,e,(!tty || done)?"\n":"";
    }' >&2
  }
  trap 'progress_stop; rm -rf -- "$github_work"' EXIT
  local -a auth_config=()
  if [ -n "$token_file" ]; then
    [ ! -L "$token_file" ] && [ -f "$token_file" ] && { exec {fd}<"$token_file"; } 2>/dev/null || {
      echo '无法打开 GitHub 私有下载凭据，请检查 DOOKNOW_GITHUB_TOKEN_FILE 是否指向可读的普通文件。' >&2
      exit 1
    }
    local shell_pid=$BASHPID
    if ! read -r mode owner links < <(stat -Lc '%a %u %h' "/proc/$shell_pid/fd/$fd" 2>/dev/null) ||
      ! { [[ "$mode" =~ ^[0-7]{3,4}$ ]] && (( (8#$mode & 077) == 0 )) && [ "$owner" = "$EUID" ] && [ "$links" = 1 ]; }; then
      echo 'GitHub 凭据必须为当前用户拥有的私有普通文件，文件只能由当前用户读写且不能使用链接。请核对文件归属和权限。' >&2
      exit 1
    fi
    token="$(cat <&"$fd" 2>/dev/null)" || { echo '无法读取 GitHub 私有下载凭据，请检查文件权限。' >&2; exit 1; }
    exec {fd}<&-
    [[ "$token" =~ ^[A-Za-z0-9_-]{20,4096}$ ]] || {
      echo 'GitHub 凭据格式不正确，请确认文件中只填写访问令牌。' >&2
      exit 1
    }
    if ! {
      printf 'header = "Authorization: Bearer %s"\nheader = "Accept: application/octet-stream"\nheader = "X-GitHub-Api-Version: 2022-11-28"\n' "$token" > "$github_work/curl" &&
        printf 'header = Authorization: Bearer %s\nheader = Accept: application/octet-stream\nheader = X-GitHub-Api-Version: 2022-11-28\n' "$token" > "$github_work/wget"
    } 2>/dev/null; then
      echo '无法写入 GitHub 下载所需的私有临时文件，请检查磁盘空间、配额和目录权限。' >&2
      exit 1
    fi
    unset token
  fi
  if [ -z "$client" ]; then
    if command -v curl >/dev/null; then client=curl; else client=wget; fi
  fi
  if { [ "$client" != curl ] && [ "$client" != wget ]; } || ! command -v "$client" >/dev/null; then
    echo 'GitHub 下载需要 curl 或 GNU wget，请安装其中一个后重试。' >&2
    exit 1
  fi
  local api="https://api.github.com/repos/$repository/releases/assets/$asset_id" location
  if [ -z "$token_file" ] && [ -n "$public_url" ]; then
    [[ "$public_url" == "https://github.com/$repository/releases/download/"* && "$public_url" != *[$'\r\n\t ?#']* ]] || {
      echo 'GitHub 公开制品地址无效，请从项目 README 重新获取安装命令。' >&2
      exit 1
    }
    api="$public_url"
  fi
  # Only numeric metadata is displayed; headers, signed URLs and errors stay private.
  local progress_owner=$BASHPID
  (
    trap - EXIT
    trap 'exit 0' TERM INT
    while kill -0 "$progress_owner" 2>/dev/null && [ -d "$github_work" ]; do progress_line; sleep 1; done
  ) 9>&- </dev/null &
  progress_pid=$!

  local status
  request_asset() {
    local url="$1" stage="$2" allow_redirect="$3" rc=0 details_file="$github_work/headers"
    if [ "$client" = curl ]; then
      details_file="$github_work/error"
      status="$(LC_ALL=C curl -q "${auth_config[@]}" --proto '=https' --max-redirs 0 --connect-timeout 20 --max-time 600 --silent --show-error --dump-header "$github_work/headers" --output "$github_work/asset" --write-out '%{http_code}' "$url" 2>"$details_file")" || rc=$?
    else
      LC_ALL=C wget --no-netrc "${auth_config[@]}" --max-redirect=0 --timeout=600 --server-response -O "$github_work/asset" "$url" 2>"$details_file" || rc=$?
      status="$(awk '/^[[:space:]]*HTTP\// && $2 ~ /^[0-9][0-9][0-9]$/ {code=$2} END {print code}' "$details_file")"
    fi
    # wget reports HTTP errors and the blocked first redirect with its HTTP error exit code.
    if (( rc != 0 )) && ! { [[ "$client:$rc" == wget:8 || "$status" == 407 ]] && [[ "$status" =~ ^[345][0-9]{2}$ ]]; }; then
      progress_stop failed
      dooknow_download_transport_error "$stage" "$client" "$rc" "$details_file"
      exit 1
    fi
    if [[ "$status" == 200 || ( "$allow_redirect" == yes && "$status" == 302 ) ]]; then return; fi
    progress_stop failed
    local cause
    case "$status" in
      401) cause='下载认证失败，请核对令牌是否有效以及是否有读取仓库发行制品的权限。' ;;
      403|429)
        if [[ "$status" == 429 ]] || awk '
          tolower($1) == "retry-after:" || (tolower($1) == "x-ratelimit-remaining:" && $2 ~ /^0[[:space:]]*$/) {limited=1}
          END {exit !limited}
        ' "$github_work/headers"; then
          cause='GitHub 下载受限，请等待限流解除后重试。'
        elif [[ "$allow_redirect" == no ]]; then
          cause='GitHub 文件下载被拒绝或临时链接已过期，请重跑原安装命令并检查代理。'
        else
          cause='GitHub 拒绝访问，请核对仓库的访问权限、令牌和代理。'
        fi
        ;;
      404|410) cause='对应的发行版或制品不可用，请核对发布状态及私有仓库的读取权限。' ;;
      407) cause='代理要求认证，请核对代理地址和凭据。' ;;
      3[0-9][0-9]) cause='下载返回了非预期跳转，请检查发行地址和代理规则。' ;;
      5[0-9][0-9]) cause='GitHub 下载服务或代理返回服务端错误，请稍后重试。' ;;
      [1-4][0-9][0-9]) cause='GitHub 返回了非预期响应，请核对发行地址、仓库权限和代理。' ;;
      *) cause='下载未收到有效的 HTTP 响应，请检查网络和代理。'; status='未知' ;;
    esac
    printf '%s失败（HTTP %s）。%s\n' "$stage" "$status" "$cause" >&2
    exit 1
  }

  if [ -n "$token_file" ]; then
    auth_config=(--config "$github_work/$client")
  elif [ "$client" = wget ]; then
    auth_config=(--no-config)
  fi
  request_asset "$api" '获取 GitHub 发行制品' yes
  if [ "$status" = 302 ]; then
    # wget also prints an unindented diagnostic "Location: ... [following]".
    # Only its indented --server-response fields are actual HTTP headers.
    location="$(awk -v client="$client" 'tolower($1)=="location:" && (client!="wget" || /^[ \t]/) {count++;sub(/^[ \t]*[^:]*:[ \t]*/, "");sub(/\r$/, "");url=$0} END {if(count!=1)exit 1;print url}' "$github_work/headers")" || {
      progress_stop failed
      echo 'GitHub 制品跳转地址缺失或重复，请检查代理是否改写了 HTTP 响应。' >&2
      exit 1
    }
    [[ "$location" =~ ^https://(release-assets\.githubusercontent\.com|objects\.githubusercontent\.com|github-releases\.githubusercontent\.com)/ && "$location" != *[$'\r\n\t ']* ]] || {
      progress_stop failed
      echo 'GitHub 制品跳转到了未经允许的地址，已停止下载。请确认代理未改写跳转，再用项目 README 中的命令重试。' >&2
      exit 1
    }
    # Omit credential configuration on the CDN request.
    auth_config=()
    if [ "$client" = wget ]; then auth_config=(--no-config); fi
    request_asset "$location" '下载 GitHub 发行文件' no
  fi
  if [ ! -s "$github_work/asset" ]; then
    progress_stop failed
    echo 'GitHub 返回了空文件，请确认对应制品已上传完整，并检查代理后重试。' >&2
    exit 1
  fi
  progress_stop
  progress_line 1
  mv -T -- "$github_work/asset" "$destination" 2>/dev/null || {
    echo 'GitHub 文件已下载，但无法保存到目标位置，请检查目录权限、剩余空间和磁盘配额。' >&2
    exit 1
  }
)

  local tool work cleanup_path
  for tool in mktemp sha256sum; do
    command -v "$tool" >/dev/null || { echo "安装引导缺少必要命令 $tool，请安装系统工具后重试。" >&2; return 1; }
  done
  work="$(mktemp -d "${TMPDIR:-/tmp}/dooknow-bootstrap.XXXXXXXX" 2>/dev/null)" || {
    echo '无法创建安装引导的临时目录，请检查 TMPDIR 或 /tmp 的写入权限、磁盘空间和配额。' >&2
    return 1
  }
  printf -v cleanup_path '%q' "$work"
  trap "rm -rf -- $cleanup_path" EXIT
  github_fetch 'bandoo-2001/doo-know' '781368232' "$work/install.sh" "" 'https://github.com/bandoo-2001/doo-know/releases/download/v1.1.0-rc.71/install.sh' || {
    echo '未能取得 DooKnow v1.1.0-rc.71 的安装脚本。请修复上方错误后重跑原安装命令。' >&2
    return 1
  }
  if ! printf '%s  %s\n' '66419c916a06333dd91359c57489deca117cff04aefaffa85069b95d86b3b2f3' "$work/install.sh" | sha256sum --status -c -; then
    echo 'DooKnow v1.1.0-rc.71 安装脚本的 SHA-256 校验失败。请从项目 README 重新获取安装命令，并检查代理缓存或发行制品是否异常。' >&2
    return 1
  fi
  bash "$work/install.sh" "$@"
}
main "$@"
