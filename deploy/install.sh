#!/usr/bin/env bash
# Keep every effect in main: a truncated pipe must never execute a partial installer.
main() {
  set -euo pipefail
  umask 077
  # __DOOKNOW_GITHUB_FETCH_FUNCTION__
  echo '[1/6] 检查安装环境…' >&2
  local source="${DOOKNOW_SOURCE:-__DOOKNOW_RELEASE_SOURCE__}" node_sha='__DOOKNOW_NODE_BINARY_SHA__'
  source="${source%/}"
  if ! [[ "$source" =~ ^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?$ || "$source" =~ ^http://(localhost|127\.0\.0\.1|\[::1\])(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?$ ]]; then
    echo '安装源必须为HTTPS或本机受控测试地址，不能包含凭据或查询参数' >&2; return 1
  fi
  [ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ] || { echo '首版仅支持Linux x86_64' >&2; return 1; }
  local command
  for command in tar sha256sum flock readlink getconf df awk stat sleep; do command -v "$command" >/dev/null || { echo "缺少必要命令：$command" >&2; return 1; }; done
  command -v curl >/dev/null || command -v wget >/dev/null || { echo '需要curl或wget' >&2; return 1; }
  local libc
  libc="$(getconf GNU_LIBC_VERSION 2>/dev/null)" || { echo '需要glibc，不支持musl' >&2; return 1; }
  [[ "$libc" =~ ^glibc\ ([0-9]+)\.([0-9]+)$ ]] && (( BASH_REMATCH[1] > 2 || (BASH_REMATCH[1] == 2 && BASH_REMATCH[2] >= 34) )) || { echo '需要glibc 2.34或更新版本' >&2; return 1; }
  if [ "${DOOKNOW_NO_SERVICE:-0}" != 1 ]; then
    command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1 || { echo 'systemd用户服务不可用；请先建立用户登录会话。仅前台使用可显式设置DOOKNOW_NO_SERVICE=1。' >&2; return 1; }
  fi
  local base="${DOOKNOW_INSTALL_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/doo-know}"
  local bindir="${DOOKNOW_BIN_DIR:-$HOME/.local/bin}" cache="${XDG_CACHE_HOME:-$HOME/.cache}/doo-know/downloads"
  mkdir -p "$base/releases" "$bindir" "$cache"
  [ "$(df -Pk "$base" | awk 'NR==2 {print $4}')" -ge 786432 ] || { echo '安装至少需要768MiB可用空间' >&2; return 1; }
  exec 9>"$base/install.lock"
  flock -n 9 || { echo '另一个安装正在进行' >&2; return 1; }
  local work cleanup_path
  work="$(mktemp -d "$base/.install.XXXXXXXX")"
  printf -v cleanup_path '%q' "$work"
  trap "rm -rf -- $cleanup_path" EXIT
  fetch() {
    if [[ "$source" =~ ^https://github\.com/([A-Za-z0-9-]+/[A-Za-z0-9_.-]+)/releases/download/([A-Za-z0-9.+-]+)$ ]]; then
      local repository="${BASH_REMATCH[1]}" asset_id
      case "$1" in
        "$source/release.txt") asset_id='__DOOKNOW_GITHUB_RELEASE_TXT_ASSET__' ;;
        "$source/dooknow-__DOOKNOW_RELEASE_VERSION__-linux-x64.tar.gz") asset_id='__DOOKNOW_GITHUB_APPLICATION_ASSET__' ;;
        *) echo '安装脚本与 GitHub 固定发布不匹配' >&2; return 1 ;;
      esac
      github_fetch "$repository" "$asset_id" "$2" "" "$1"
      return
    fi
    if command -v curl >/dev/null; then curl -fL --progress-bar --proto '=https,http' --proto-redir '=https' --connect-timeout 20 --max-time 600 "$1" -o "$2"
    else wget -q --show-progress --progress=bar:force:noscroll --max-redirect=0 --timeout=600 -O "$2" "$1"; fi
  }
  echo '[2/6] 下载发行清单…' >&2
  fetch "$source/release.txt" "$work/release.txt"
  local version filename checksum extra
  read -r version filename checksum extra < "$work/release.txt"
  [[ "$version" =~ ^[0-9][a-zA-Z0-9.+-]{0,79}$ ]] && [ "$filename" = "dooknow-$version-linux-x64.tar.gz" ] && [[ "$checksum" =~ ^[a-f0-9]{64}$ ]] && [ -z "$extra" ] || { echo '无效发行清单' >&2; return 1; }
  echo "正在准备 DooKnow $version…"
  local archive="$cache/$checksum.tar.gz"
  if [ -f "$archive" ] && ! printf '%s  %s\n' "$checksum" "$archive" | sha256sum -c - >/dev/null 2>&1; then rm -- "$archive"; fi
  if [ ! -f "$archive" ]; then
    echo '[3/6] 下载应用安装包…' >&2
    fetch "$source/$filename" "$work/package.tar.gz"
    echo '[4/6] 校验应用安装包…' >&2
    printf '%s  %s\n' "$checksum" "$work/package.tar.gz" | sha256sum -c - >/dev/null || { echo '发行包校验失败' >&2; return 1; }
    mv "$work/package.tar.gz" "$archive"
  fi
  echo '[5/6] 解包应用并校验运行时…' >&2
  # Only execute the pinned Node and checksum-verified standalone validator before extraction.
  tar -xOzf "$archive" ./runtime/node/bin/node > "$work/node"
  printf '%s  %s\n' "$node_sha" "$work/node" | sha256sum -c - >/dev/null || { echo '运行时校验失败' >&2; return 1; }
  chmod 700 "$work/node"
  tar -xOzf "$archive" ./deploy/check-archive.mjs > "$work/check-archive.mjs"
  "$work/node" "$work/check-archive.mjs" "$archive"
  local release="$base/releases/$version"
  if [ -e "$release" ]; then
    [ -f "$release/package.sha256" ] && [ "$(cat "$release/package.sha256")" = "$checksum" ] || { echo '同版本发行内容不同，拒绝覆盖' >&2; return 1; }
  else
    mkdir "$work/application"
    tar --no-same-owner --no-same-permissions -xzf "$archive" -C "$work/application"
    printf '%s\n' "$checksum" > "$work/application/package.sha256"
    mv "$work/application" "$release"
  fi
  echo '[6/6] 初始化账号与服务…' >&2
  local args=(install --install-root "$base")
  local github_repository=''
  if [[ "$source" =~ ^https://github\.com/([A-Za-z0-9-]+/[A-Za-z0-9_.-]+)/releases/download/([A-Za-z0-9.+-]+)$ ]]; then
    github_repository="${BASH_REMATCH[1]}"
    args+=(--github-repository "$github_repository")
    [ -z "${DOOKNOW_GITHUB_TOKEN_FILE:-}" ] || args+=(--github-token-file "$DOOKNOW_GITHUB_TOKEN_FILE")
  fi
  [ -z "${DOOKNOW_PROFILE:-}" ] || args+=(--profile "$DOOKNOW_PROFILE")
  [ -z "${DOOKNOW_PORT:-}" ] || args+=(--port "$DOOKNOW_PORT")
  [ -z "${DOOKNOW_APP_ORIGIN:-}" ] || args+=(--origin "$DOOKNOW_APP_ORIGIN")
  [ -z "${DOOKNOW_ALLOW_ROOT:-}" ] || args+=(--allow-root "$DOOKNOW_ALLOW_ROOT")
  [ -z "${DOOKNOW_SERVICE_NAME:-}" ] || args+=(--service-name "$DOOKNOW_SERVICE_NAME")
  [ "${DOOKNOW_NO_SERVICE:-0}" != 1 ] || args+=(--no-service)
  if [ -L "$base/current" ] && [ "$(readlink -f "$base/current")" != "$release" ]; then
    local current
    current="$(readlink -f "$base/current")"
    local update_args=(update --source "$source" --version "$version" --install-root "$base")
    [ -z "${DOOKNOW_PROFILE:-}" ] || update_args+=(--profile "$DOOKNOW_PROFILE")
    [ "${DOOKNOW_NO_SERVICE:-0}" != 1 ] || update_args+=(--no-service)
    if [ -n "$github_repository" ]; then
      update_args+=(--github-repository "$github_repository")
      [ -z "${DOOKNOW_GITHUB_TOKEN_FILE:-}" ] || update_args+=(--github-token-file "$DOOKNOW_GITHUB_TOKEN_FILE")
      "$release/runtime/node/bin/node" "$release/dist/server/scripts/manage.js" "${update_args[@]}"
    else
      "$current/runtime/node/bin/node" "$current/dist/server/scripts/manage.js" "${update_args[@]}"
    fi
  else
    if ( : </dev/tty ) 2>/dev/null; then
      "$release/runtime/node/bin/node" "$release/dist/server/scripts/manage.js" "${args[@]}" </dev/tty
    elif ! "$release/runtime/node/bin/node" "$release/dist/server/scripts/manage.js" "${args[@]}"; then
      printf '初始化尚未完成。请在本机终端执行：\n%q %q' "$release/runtime/node/bin/node" "$release/dist/server/scripts/manage.js" >&2
      printf ' %q' "${args[@]}" >&2; printf '\n' >&2; return 1
    fi
    ln -s "releases/$version" "$base/.current-$$"
    mv -Tf "$base/.current-$$" "$base/current"
  fi
  local install_id
  install_id="$(printf '%s' "$base" | sha256sum)"; install_id="${install_id%% *}"
  {
    printf '#!/usr/bin/env bash\n# DooKnow install: %s\nset -euo pipefail\nexport DOOKNOW_INSTALL_ROOT=%q\n' "$install_id" "$base"
    printf 'release_root="$(readlink -f "$DOOKNOW_INSTALL_ROOT/current")"\nexec "$release_root/runtime/node/bin/node" "$release_root/dist/server/scripts/manage.js" "$@"\n'
  } > "$work/dooknow"
  chmod 700 "$work/dooknow"
  mv "$work/dooknow" "$bindir/dooknow"
  echo "管理命令：$bindir/dooknow"
}
main "$@"
