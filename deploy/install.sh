#!/usr/bin/env bash
# All effects stay in main so an incomplete download cannot execute a partial installer.
main() {
  set -euo pipefail
  umask 077
  local source="${DOOKNOW_SOURCE:-__DOOKNOW_RELEASE_SOURCE__}"
  source="${source%/}"
  case "$source" in https://*|http://127.0.0.1:*|http://localhost:*) ;; *) echo '安装源必须为HTTPS或本机受控测试地址' >&2; return 1;; esac
  [ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ] || { echo '首版仅支持Linux x86_64' >&2; return 1; }
  local command
  for command in tar sha256sum flock readlink; do command -v "$command" >/dev/null || { echo "缺少必要命令：$command" >&2; return 1; }; done
  command -v curl >/dev/null || command -v wget >/dev/null || { echo '需要curl或wget' >&2; return 1; }
  local base="${XDG_DATA_HOME:-$HOME/.local/share}/doo-know"
  local bindir="${DOOKNOW_BIN_DIR:-$HOME/.local/bin}"
  mkdir -p "$base/releases" "$bindir"
  exec 9>"$base/install.lock"
  flock -n 9 || { echo '另一个安装正在进行' >&2; return 1; }
  local work
  work="$(mktemp -d "$base/.install.XXXXXXXX")"
  local cleanup_path
  printf -v cleanup_path '%q' "$work"
  trap "rm -rf -- $cleanup_path" EXIT
  fetch() {
    if command -v curl >/dev/null; then curl -fsSL --connect-timeout 20 --max-time 600 "$1" -o "$2"
    else wget -q --timeout=600 -O "$2" "$1"; fi
  }
  fetch "$source/release.txt" "$work/release.txt"
  local version filename checksum extra
  read -r version filename checksum extra < "$work/release.txt"
  [[ "$version" =~ ^[0-9][a-zA-Z0-9.+-]{0,79}$ ]] && [[ "$filename" =~ ^dooknow-[a-zA-Z0-9.+-]+-linux-x64\.tar\.gz$ ]] && [[ "$checksum" =~ ^[a-f0-9]{64}$ ]] && [ -z "$extra" ] || { echo '无效发行清单' >&2; return 1; }
  echo "正在下载 DooKnow $version…"
  fetch "$source/$filename" "$work/package.tar.gz"
  printf '%s  %s\n' "$checksum" "$work/package.tar.gz" | sha256sum -c - >/dev/null
  local release="$base/releases/$version"
  if [ -e "$release" ]; then
    [ -f "$release/package.sha256" ] && [ "$(cat "$release/package.sha256")" = "$checksum" ] || { echo '同版本发行内容不同，拒绝覆盖' >&2; return 1; }
  else
    mkdir "$work/application"
    tar --no-same-owner --no-same-permissions -xzf "$work/package.tar.gz" -C "$work/application"
    printf '%s\n' "$checksum" > "$work/application/package.sha256"
    mv "$work/application" "$release"
  fi
  [ -x "$release/runtime/node/bin/node" ] || { echo '发行包缺少运行时' >&2; return 1; }
  "$release/runtime/node/bin/node" -e 'process.exit(process.platform==="linux"&&process.arch==="x64"?0:1)'
  ln -s "releases/$version" "$base/.current-$$"
  mv -Tf "$base/.current-$$" "$base/current"
  {
    printf '#!/usr/bin/env bash\nset -euo pipefail\nDOOKNOW_INSTALL_ROOT=%q\n' "$base"
    printf 'release_root="$(readlink -f "$DOOKNOW_INSTALL_ROOT/current")"\nexec "$release_root/runtime/node/bin/node" "$release_root/dist/server/scripts/manage.js" "$@"\n'
  } > "$bindir/dooknow"
  chmod 700 "$bindir/dooknow"
  local args=(install)
  [ -z "${DOOKNOW_PROFILE:-}" ] || args+=(--profile "$DOOKNOW_PROFILE")
  [ -z "${DOOKNOW_PORT:-}" ] || args+=(--port "$DOOKNOW_PORT")
  [ -z "${DOOKNOW_APP_ORIGIN:-}" ] || args+=(--origin "$DOOKNOW_APP_ORIGIN")
  [ -z "${DOOKNOW_ALLOW_ROOT:-}" ] || args+=(--allow-root "$DOOKNOW_ALLOW_ROOT")
  [ "${DOOKNOW_NO_SERVICE:-0}" != 1 ] || args+=(--no-service)
  if ( : </dev/tty ) 2>/dev/null; then "$bindir/dooknow" "${args[@]}" </dev/tty
  else "$bindir/dooknow" "${args[@]}"; fi
  echo "管理命令：$bindir/dooknow"
}
main "$@"
