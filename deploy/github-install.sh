#!/usr/bin/env bash
# Generated pinned release bootstrap; contains no credentials.
main() {
  set +x
  set -euo pipefail
  umask 077
# Embedded into generated installers; no dependency on Node, Python, jq or gh.
github_fetch() (
  set +x
  set -euo pipefail
  umask 077
  for tool in stat sleep awk; do command -v "$tool" >/dev/null || { echo "缺少必要命令：$tool" >&2; exit 1; }; done
  local repository="$1" asset_id="$2" destination="$3" client="${4:-}"
  [[ "$repository" =~ ^[A-Za-z0-9-]+/[A-Za-z0-9_.-]+$ && "$asset_id" =~ ^[1-9][0-9]*$ ]] || { echo '无效 GitHub 制品标识' >&2; exit 1; }
  local token_file="${DOOKNOW_GITHUB_TOKEN_FILE:-}" fd mode owner links token public_url="${5:-}"
  local github_work
  github_work="$(mktemp -d "$(dirname "$destination")/.github-download.XXXXXXXX")"
  local progress_pid='' progress_started=$SECONDS
  progress_stop() {
    if [ -n "$progress_pid" ]; then kill "$progress_pid" 2>/dev/null || true; wait "$progress_pid" 2>/dev/null || true; progress_pid=''; fi
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
      printf "%s进度 %s | 已下载 %.2f MiB | 速度 %.2f MiB/s | 剩余 %s | 已用 %d 秒%s",tty?"\r":"",prefix,b/1048576,rate/1048576,done?"0 秒":eta,e,(!tty || done)?"\n":"";
    }' >&2
  }
  trap 'progress_stop; rm -rf -- "$github_work"' EXIT
  # Only numeric metadata is displayed; headers, signed URLs and errors stay private.
  local progress_owner=$BASHPID
  (
    trap - EXIT
    trap 'exit 0' TERM INT
    while kill -0 "$progress_owner" 2>/dev/null && [ -d "$github_work" ]; do progress_line; sleep 1; done
  ) 9>&- </dev/null &
  progress_pid=$!
  local -a auth_config=()
  if [ -n "$token_file" ]; then
    [ ! -L "$token_file" ] && [ -f "$token_file" ] || { echo '指定的 GitHub 私有下载凭据不可用' >&2; exit 1; }
    exec {fd}<"$token_file"
    local shell_pid=$BASHPID
    read -r mode owner links < <(stat -Lc '%a %u %h' "/proc/$shell_pid/fd/$fd")
    [[ "$mode" =~ ^[0-7]{3,4}$ ]] && (( (8#$mode & 077) == 0 )) && [ "$owner" = "$(id -u)" ] && [ "$links" = 1 ] || { echo 'GitHub 凭据必须为当前用户的私有普通文件' >&2; exit 1; }
    token="$(cat <&"$fd")"; exec {fd}<&-
    [[ "$token" =~ ^[A-Za-z0-9_-]{20,4096}$ ]] || { echo 'GitHub 凭据格式不正确' >&2; exit 1; }
    printf 'header = "Authorization: Bearer %s"\nheader = "Accept: application/octet-stream"\nheader = "X-GitHub-Api-Version: 2022-11-28"\n' "$token" > "$github_work/curl"
    printf 'header = Authorization: Bearer %s\nheader = Accept: application/octet-stream\nheader = X-GitHub-Api-Version: 2022-11-28\n' "$token" > "$github_work/wget"
    unset token
  fi
  if [ -z "$client" ]; then if command -v curl >/dev/null; then client=curl; else client=wget; fi; fi
  local api="https://api.github.com/repos/$repository/releases/assets/$asset_id" status location
  if [ -z "$token_file" ] && [ -n "$public_url" ]; then
    [[ "$public_url" == "https://github.com/$repository/releases/download/"* && "$public_url" != *[$'\r\n\t ?#']* ]] || { echo '无效 GitHub 公开制品地址' >&2; exit 1; }
    api="$public_url"
  fi
  if [ "$client" = curl ]; then
    [ -z "$token_file" ] || auth_config=(--config "$github_work/curl")
    status="$(curl -q "${auth_config[@]}" --proto '=https' --max-redirs 0 --connect-timeout 20 --max-time 600 --silent --show-error --dump-header "$github_work/headers" --output "$github_work/asset" --write-out '%{http_code}' "$api" 2>"$github_work/error")" || { echo 'GitHub 制品下载失败' >&2; exit 1; }
  elif [ "$client" = wget ]; then
    if [ -n "$token_file" ]; then auth_config=(--config "$github_work/wget"); else auth_config=(--no-config); fi
    wget --no-netrc "${auth_config[@]}" --max-redirect=0 --timeout=600 --server-response -O "$github_work/asset" "$api" 2>"$github_work/headers" || true
    status="$(awk '/^[[:space:]]*HTTP\// {code=$2} END {print code}' "$github_work/headers")"
  else echo '需要 curl 或 wget' >&2; exit 1; fi
  if [ "$status" = 302 ]; then
    # wget also prints an unindented diagnostic "Location: ... [following]".
    # Only its indented --server-response fields are actual HTTP headers.
    location="$(awk -v client="$client" 'tolower($1)=="location:" && (client!="wget" || /^[ \t]/) {count++;sub(/^[ \t]*[^:]+:[ \t]*/, "");sub(/\r$/, "");url=$0} END {if(count!=1)exit 1;print url}' "$github_work/headers")" || { echo '拒绝不明确的 GitHub 制品跳转' >&2; exit 1; }
    [[ "$location" =~ ^https://(release-assets\.githubusercontent\.com|objects\.githubusercontent\.com|github-releases\.githubusercontent\.com)/ && "$location" != *[$'\r\n\t ']* ]] || { echo '拒绝非 GitHub 制品跳转' >&2; exit 1; }
    # Fresh request, no credential config, no inherited curlrc/wgetrc, no further redirects.
    if [ "$client" = curl ]; then
      curl -q --proto '=https' --max-redirs 0 --connect-timeout 20 --max-time 600 --fail --silent --show-error --dump-header "$github_work/headers" --output "$github_work/asset" "$location" 2>"$github_work/error" || { echo 'GitHub 制品下载失败' >&2; exit 1; }
    else
      wget --no-config --no-netrc --max-redirect=0 --timeout=600 --server-response -O "$github_work/asset" "$location" 2>"$github_work/headers" || { echo 'GitHub 制品下载失败' >&2; exit 1; }
    fi
  elif [ "$status" != 200 ]; then
    echo "GitHub 制品不可访问（HTTP ${status:-unknown}）；请核对仓库权限、令牌与发布状态" >&2; exit 1
  fi
  [ -f "$github_work/asset" ] || { echo 'GitHub 制品下载未完成' >&2; exit 1; }
  progress_stop
  progress_line 1
  mv -- "$github_work/asset" "$destination"
)

  local work cleanup_path
  work="$(mktemp -d "${TMPDIR:-/tmp}/dooknow-bootstrap.XXXXXXXX")"
  printf -v cleanup_path '%q' "$work"
  trap "rm -rf -- $cleanup_path" EXIT
  github_fetch 'bandoo-2001/doo-know' '662702243' "$work/install.sh" "" 'https://github.com/bandoo-2001/doo-know/releases/download/v1.1.0-rc.39/install.sh'
  printf '%s  %s\n' '80b7f9d1c52ae8585c671c398d2ea2594e46443bb7b3d92febd86ae8465a4f54' "$work/install.sh" | sha256sum -c - >/dev/null
  bash "$work/install.sh" "$@"
}
main "$@"
