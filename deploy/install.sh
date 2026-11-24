#!/usr/bin/env bash
# Keep every effect in main: a truncated pipe must never execute a partial installer.
main() (
  set +x
  set -euo pipefail
  umask 077
  # __DOOKNOW_GITHUB_FETCH_FUNCTION__
  local stage='' work='' launcher_work='' reported=0
  local use_color=0
  if [ -t 2 ] && [ "${TERM:-dumb}" != dumb ] && [ -z "${NO_COLOR:-}" ]; then
    use_color=1
  fi
  message() {
    local style="$1" line="$2"
    if [ "$use_color" -eq 1 ]; then
      printf '\033[%sm%s\033[0m\n' "$style" "$line" >&2
    else
      printf '%s\n' "$line" >&2
    fi
  }
  step() {
    stage="[$1/6] $2"
    printf '\n' >&2
    message '1;36' "$stage…"
  }
  fail() {
    reported=1
    message '1;31' "${stage}失败"
    printf '%s\n' "$@" >&2
    exit 1
  }
  finish() {
    local status="$1"
    if [ "$status" -ne 0 ] && [ "$reported" -eq 0 ]; then
      printf '%s中止（退出码 %s）。请查看上方错误，处理后重跑原安装命令。\n' "$stage" "$status" >&2
    fi
    if [ -n "$work" ] && ! rm -rf -- "$work"; then
      printf '无法清理本次安装的临时目录 %q。请先核对目录权限。\n' "$work" >&2
    fi
    if [ -n "$launcher_work" ] && ! rm -f -- "$launcher_work"; then
      printf '无法清理本次安装的临时命令文件 %q。\n' "$launcher_work" >&2
    fi
  }
  make_directory() {
    local label="$1" path="$2"
    mkdir -p -- "$path" && return
    fail "$(printf '无法创建%s %q。请检查父目录权限、磁盘空间及文件系统是否只读。' "$label" "$path")"
  }
  checksum_matches() {
    local actual
    actual="$(sha256sum < "$2")" && [ "${actual%% *}" = "$1" ]
  }
  trap 'finish "$?"' EXIT

  printf '\n' >&2
  message '1;36' 'DooKnow 安装向导'
  printf '────────────────────────────────────────\n' >&2
  step 1 '检查安装环境'
  local source="${DOOKNOW_SOURCE:-__DOOKNOW_RELEASE_SOURCE__}" node_sha='__DOOKNOW_NODE_BINARY_SHA__'
  source="${source%/}"
  if ! [[ "$source" =~ ^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?$ || "$source" =~ ^http://(localhost|127\.0\.0\.1|\[::1\])(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?$ ]]; then
    fail '安装源必须为 HTTPS 或本机环回 HTTP 地址。请检查 DOOKNOW_SOURCE，地址中不能包含凭据或查询参数。'
  fi
  local command
  for command in uname tar gzip sha256sum flock readlink getconf df awk stat sleep mkdir mktemp mv ln rm chmod cat grep; do
    command -v "$command" >/dev/null || fail "缺少必要命令 $command。请检查 PATH 或安装提供该命令的系统软件包。"
  done
  command -v curl >/dev/null || command -v wget >/dev/null || fail '缺少下载工具。请安装 curl 或 wget 后重试。'
  local os arch libc
  os="$(uname -s)" && arch="$(uname -m)" || fail '无法识别当前操作系统和 CPU 架构。请检查 uname 命令。'
  if [ "$os" != Linux ] || [ "$arch" != x86_64 ]; then
    fail "$(printf '发行包要求 Linux x86_64，当前系统为 %q %q。' "$os" "$arch")"
  fi
  libc="$(getconf GNU_LIBC_VERSION 2>/dev/null)" || fail '无法检测到 glibc。此发行包要求 glibc ≥ 2.34，请使用兼容的 Linux 系统。'
  [[ "$libc" =~ ^glibc\ ([0-9]+)\.([0-9]+)$ ]] && (( BASH_REMATCH[1] > 2 || (BASH_REMATCH[1] == 2 && BASH_REMATCH[2] >= 34) )) ||
    fail "$(printf '发行包要求 glibc ≥ 2.34，当前检测结果为 %q。' "$libc")"
  if [ "${DOOKNOW_NO_SERVICE:-0}" != 1 ]; then
    command -v systemctl >/dev/null ||
      fail '找不到 systemctl。需要 systemd 用户服务才能自动启动，也可以设置 DOOKNOW_NO_SERVICE=1 安装前台版本。'
    systemctl --user show-environment >/dev/null 2>&1 ||
      fail '无法连接当前用户的 systemd。请用实际运行 DooKnow 的用户登录并检查 systemctl --user status。只需要前台运行时，可设置 DOOKNOW_NO_SERVICE=1。'
  fi
  local base="${DOOKNOW_INSTALL_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/doo-know}"
  local bindir="${DOOKNOW_BIN_DIR:-$HOME/.local/bin}" cache="${XDG_CACHE_HOME:-$HOME/.cache}/doo-know/downloads"
  local config_home profile free_kib bound_profile install_id launcher
  config_home="$(readlink -m -- "${XDG_CONFIG_HOME:-$HOME/.config}")" ||
    fail '无法解析配置根目录。请检查 XDG_CONFIG_HOME 的路径及访问权限。'
  profile="$(readlink -m -- "${DOOKNOW_PROFILE:-$config_home/doo-know/profile.json}")" ||
    fail '无法解析实例配置路径。请检查 DOOKNOW_PROFILE 及其父目录权限。'
  make_directory '程序版本目录' "$base/releases"
  make_directory '管理命令目录' "$bindir"
  make_directory '下载缓存目录' "$cache"
  base="$(readlink -f -- "$base")" || fail '无法解析程序安装目录。请检查 DOOKNOW_INSTALL_ROOT 和目录访问权限。'
  bindir="$(readlink -f -- "$bindir")" || fail '无法解析管理命令目录。请检查 DOOKNOW_BIN_DIR 和目录访问权限。'
  free_kib="$(df -Pk -- "$base" | awk 'NR==2 {print $4}')" && [[ "$free_kib" =~ ^[0-9]+$ ]] ||
    fail "$(printf '无法读取安装目录 %q 的磁盘空间。请检查目录所在磁盘是否已挂载，以及 df 是否可用。' "$base")"
  [ "$free_kib" -ge 786432 ] ||
    fail "$(printf '安装至少需要 768 MiB 可用空间，%q 所在磁盘目前可用 %s MiB。请释放空间或另选安装目录。' "$base" "$((free_kib / 1024))")"
  take_lock() {
    local descriptor="$1" lock_file="$2" lock_status=0
    flock -n -E 75 "$descriptor" || lock_status=$?
    case "$lock_status" in
      0) ;;
      75) fail '另一个安装正在进行。请等待该安装退出后再重试。' ;;
      *) fail "$(printf '无法锁定 %q（退出码 %s）。请检查目录所在文件系统是否支持文件锁。' "$lock_file" "$lock_status")" ;;
    esac
  }
  { [ ! -e "$base/install.lock" ] || [ -f "$base/install.lock" ]; } &&
    [ ! -L "$base/install.lock" ] && exec 9>>"$base/install.lock" ||
    fail "$(printf '无法安全打开安装锁 %q。请核对文件类型和权限。' "$base/install.lock")"
  take_lock 9 "$base/install.lock"
  check_profile_binding() {
    [ -f "$base/profile.path" ] && [ ! -L "$base/profile.path" ] &&
      bound_profile="$(cat -- "$base/profile.path")" && [[ "$bound_profile" = /* ]] ||
      fail "$(printf '无法读取安装目录的归属记录 %q。请核对原安装的配置和目录权限。' "$base/profile.path")"
    [ "$bound_profile" = "$profile" ] ||
      fail "$(printf '此安装目录已绑定另一配置 %q，当前指定 %q。继续使用旧实例请选择原配置。独立安装请另选 DOOKNOW_INSTALL_ROOT。' "$bound_profile" "$profile")"
  }
  if [ -e "$base/profile.path" ] || [ -L "$base/profile.path" ]; then
    check_profile_binding
  fi
  if { [ -e "$base/profile.path" ] || [ -L "$base/current" ]; } && [ ! -f "$profile" ]; then
    fail "$(printf '已有安装的配置文件不存在或不是普通文件。请恢复原配置 %q。全新安装需要独立的配置和程序目录。' "$profile")"
  fi
  if [ -e "$base/current" ] && [ ! -L "$base/current" ]; then
    fail "$(printf '当前版本路径 %q 被其他文件占用。请核对安装目录。' "$base/current")"
  fi

  # Different profiles can use the same bin directory. Serialize ownership
  # checks and publication even when their installation roots are different.
  launcher="$bindir/dooknow"
  install_id="$(printf '%s' "$base" | sha256sum)"
  install_id="${install_id%% *}"
  { [ ! -e "$bindir/.dooknow-install.lock" ] || [ -f "$bindir/.dooknow-install.lock" ]; } &&
    [ ! -L "$bindir/.dooknow-install.lock" ] && exec 8>>"$bindir/.dooknow-install.lock" ||
    fail "$(printf '无法安全打开管理命令安装锁 %q。请核对文件类型和权限。' "$bindir/.dooknow-install.lock")"
  take_lock 8 "$bindir/.dooknow-install.lock"
  check_launcher() {
    if [ ! -e "$launcher" ] && [ ! -L "$launcher" ]; then return; fi
    if [ -f "$launcher" ] && [ ! -L "$launcher" ] && [ -O "$launcher" ]; then
      if grep -Fxq -- "# DooKnow install: $install_id" "$launcher"; then return; fi
      if [[ "$base" =~ ^[A-Za-z0-9_./@+-]+$ ]] &&
        grep -Fxq -e "export DOOKNOW_INSTALL_ROOT=$base" -e "DOOKNOW_INSTALL_ROOT=$base" -- "$launcher"; then
        return
      fi
    fi
    fail "$(printf '管理命令路径已被其他安装或文件占用 %q。独立安装请指定不同的 DOOKNOW_BIN_DIR。' "$launcher")"
  }
  check_launcher
  work="$(mktemp -d -- "$base/.install.XXXXXXXX")" ||
    fail "$(printf '无法在 %q 创建安装临时目录。请检查权限、磁盘空间和 inode 余量。' "$base")"

  fetch() {
    local url="$1" destination="$2" label="$3"
    if [[ "$source" =~ ^https://github\.com/([A-Za-z0-9-]+/[A-Za-z0-9_.-]+)/releases/download/([A-Za-z0-9.+-]+)$ ]]; then
      local repository="${BASH_REMATCH[1]}" asset_id
      case "$url" in
        "$source/release.txt") asset_id='__DOOKNOW_GITHUB_RELEASE_TXT_ASSET__' ;;
        "$source/dooknow-__DOOKNOW_RELEASE_VERSION__-linux-x64.tar.gz") asset_id='__DOOKNOW_GITHUB_APPLICATION_ASSET__' ;;
        *) fail '安装脚本与 GitHub 固定发布不匹配。请重新获取该版本对应的完整官方安装命令。' ;;
      esac
      github_fetch "$repository" "$asset_id" "$destination" '' "$url" ||
        fail "${label}未下载完成。请按上面的 GitHub 下载提示处理后重试。"
      return
    fi
    local client status rc=0 advice error_file="$work/download-error"
    if command -v curl >/dev/null; then
      client=curl
      status="$(LC_ALL=C curl -fsSL --proto '=https,http' --proto-redir '=https' --connect-timeout 20 --max-time 600 \
        --write-out '%{http_code}' "$url" -o "$destination" 2>"$error_file")" || rc=$?
    else
      client=wget
      LC_ALL=C wget --no-verbose --server-response --max-redirect=0 --timeout=600 -O "$destination" "$url" \
        2>"$error_file" || rc=$?
      status="$(awk '/^[[:space:]]*HTTP\// {code=$2} END {print code}' "$error_file")"
    fi
    if [ "$rc" -eq 0 ] && [[ "$status" == 2[0-9][0-9] ]]; then
      return 0
    fi
    case "$status" in
      401|403) advice='请检查制品源访问权限及认证配置。' ;;
      404|410) advice='请核对 DOOKNOW_SOURCE、版本和制品文件是否已发布。' ;;
      407) advice='代理需要认证。请检查当前终端的代理配置。' ;;
      408|429|5[0-9][0-9]) advice='下载源或代理暂时不可用或限流。请稍后重试。' ;;
      3[0-9][0-9]) advice='请确认源是否返回了客户端不允许跟随的重定向，或改用最终制品地址。' ;;
      4[0-9][0-9]) advice='请检查下载源地址、请求限制和权限。' ;;
      *)
        if [ "$rc" -eq 0 ]; then
          printf '%s未收到有效的 HTTP 成功响应。请检查发行源是否提供了下载文件。\n' "$label" >&2
        elif declare -F dooknow_download_transport_error >/dev/null; then
          dooknow_download_transport_error "${label}下载" "$client" "$rc" "$error_file"
        else
          printf '%s下载失败（%s 退出码 %s）。请检查 DNS、网络、代理、证书和暂存目录空间。\n' "$label" "$client" "$rc" >&2
        fi
        fail '处理下载问题后，请重跑原安装命令。'
        ;;
    esac
    fail "${label}下载失败（HTTP $status）。$advice"
  }

  step 2 '下载发行清单'
  fetch "$source/release.txt" "$work/release.txt" '发行清单'
  local version filename checksum extra
  [ -s "$work/release.txt" ] || fail '下载的 release.txt 为空。请检查制品源上的发行清单。'
  read -r version filename checksum extra < "$work/release.txt" ||
    fail '无法读取 release.txt 的首行。请确认下载内容是完整的发行清单。'
  [[ "$version" =~ ^[0-9][a-zA-Z0-9.+-]{0,79}$ ]] ||
    fail '发行清单的版本字段无效。请检查 release.txt，或重试对应版本的官方安装命令。'
  [ "$filename" = "dooknow-$version-linux-x64.tar.gz" ] ||
    fail "发行清单的包名与版本或平台不匹配。请确认发行源提供 dooknow-$version-linux-x64.tar.gz。"
  [[ "$checksum" =~ ^[a-f0-9]{64}$ ]] && [ -z "$extra" ] ||
    fail '发行清单的 SHA-256 校验字段无效或存在多余字段。请使用完整的官方发行清单。'
  printf '正在准备 DooKnow %s…\n' "$version"

  local archive="$cache/$checksum.tar.gz" cached=0
  step 3 '下载应用安装包'
  if [ -f "$archive" ]; then
    if checksum_matches "$checksum" "$archive" 2>/dev/null; then
      cached=1
      printf '使用已下载的缓存。\n' >&2
    else
      printf '缓存校验未通过，将重新下载安装包。\n' >&2
    fi
  fi
  if [ "$cached" -eq 0 ]; then
    fetch "$source/$filename" "$work/package.tar.gz" '应用安装包'
  fi
  step 4 '校验应用安装包'
  if [ "$cached" -eq 0 ]; then
    checksum_matches "$checksum" "$work/package.tar.gz" 2>/dev/null ||
      fail "安装包 $filename 与发行清单的 SHA-256 不匹配或无法读取。请重新下载。若重复失败，请核对安装源。"
    mv -Tf -- "$work/package.tar.gz" "$archive" ||
      fail "$(printf '安装包已通过校验，但无法写入下载缓存 %q。请检查目录权限、磁盘空间和文件系统。' "$cache")"
  fi
  message '1;32' '应用安装包 SHA-256 校验通过。'

  step 5 '解包应用并校验运行时'
  # Only execute the pinned Node and checksum-verified standalone validator before extraction.
  tar -xOzf "$archive" ./runtime/node/bin/node > "$work/node" ||
    fail '无法从安装包读取内置 Node.js。请检查安装包完整性和安装目录可用空间。'
  checksum_matches "$node_sha" "$work/node" 2>/dev/null ||
    fail '内置 Node.js 的 SHA-256 与安装脚本不符。请重新获取同一版本的一整套发行文件。'
  chmod 700 "$work/node" ||
    fail "$(printf '无法设置内置 Node.js 的执行权限。请检查安装目录 %q 权限和文件系统。' "$base")"
  tar -xOzf "$archive" ./deploy/check-archive.mjs > "$work/check-archive.mjs" ||
    fail '无法从安装包读取归档校验程序。请检查发行包结构和安装目录可用空间。'
  "$work/node" "$work/check-archive.mjs" "$archive" > "$work/archive-check.json" ||
    fail "$(printf '归档安全校验程序未成功运行。请查看上方错误，并检查 %q 所在挂载点是否允许执行、发行包是否完整。' "$base")"
  message '1;32' '归档安全校验通过。'
  local release="$base/releases/$version"
  if [ -e "$release" ]; then
    [ -f "$release/package.sha256" ] && [ "$(cat -- "$release/package.sha256")" = "$checksum" ] ||
      fail "$(printf '同版本发行内容不同或缺少校验记录，已停止覆盖 %q。请先核对现有版本的安装来源。' "$release")"
  else
    make_directory '解包目录' "$work/application"
    tar --no-same-owner --no-same-permissions -xzf "$archive" -C "$work/application" ||
      fail "$(printf '无法解包 %s。请检查 %q 所在磁盘的空间、inode 余量和目录权限。' "$filename" "$base")"
    printf '%s\n' "$checksum" > "$work/application/package.sha256" ||
      fail '无法写入发行包校验记录。请检查安装目录的权限和磁盘空间。'
    mv -T -- "$work/application" "$release" ||
      fail "$(printf '无法将解包结果安装到 %q。请检查该路径是否受占用，以及安装目录是否可写。' "$release")"
  fi

  step 6 '初始化账号与服务'
  local tty_available=0
  local node_options="${NODE_OPTIONS:+$NODE_OPTIONS }--disable-warning=UNDICI-EHPA"
  if ( : </dev/tty ) 2>/dev/null; then tty_available=1; fi

  publish_launcher() {
    check_launcher
    launcher_work="$(mktemp -- "$bindir/.dooknow.XXXXXXXX")" ||
      fail "$(printf '无法在 %q 暂存管理命令。请核对目录权限和磁盘空间。' "$bindir")"
    {
      printf '#!/usr/bin/env bash\n# DooKnow install: %s\nset -euo pipefail\nexport DOOKNOW_INSTALL_ROOT=%q\n' "$install_id" "$base"
      printf 'export DOOKNOW_PROFILE=%q\nexport XDG_CONFIG_HOME=%q\nexport DOOKNOW_BIN_DIR=%q\n' "$profile" "$config_home" "$bindir"
      printf 'release_root="$(readlink -f "$DOOKNOW_INSTALL_ROOT/current")"\nexec "$release_root/runtime/node/bin/node" "$release_root/dist/server/scripts/manage.js" "$@"\n'
    } > "$launcher_work"
    chmod 700 "$launcher_work" && mv -Tf -- "$launcher_work" "$launcher" ||
      fail "$(printf '程序已就绪，但无法发布管理命令 %q。请核对 DOOKNOW_BIN_DIR 的写入权限。处理后重跑原安装命令。' "$launcher")"
    launcher_work=''
  }

  choose_new_instance() {
    local answer
    message '1;33' '旧知识库暂不可用。可以等待原目录恢复，或者另建一个新实例。'
    while true; do
      message '1;36' '创建独立的新实例？[y/N/q]  Y 新建，N 等待后重试，Q 退出'
      IFS= read -r answer </dev/tty || return 2
      case "$answer" in
        [yY]) return 0 ;;
        [qQ]) return 2 ;;
        ''|[nN]) break ;;
        *) message '33' '请输入 Y、N 或 Q。' ;;
      esac
    done
    while true; do
      message '1;36' '恢复原目录或挂载后按回车重试，输入 Q 退出。'
      IFS= read -r answer </dev/tty || return 2
      case "$answer" in
        '') return 1 ;;
        [qQ]) return 2 ;;
        *) message '33' '请按回车或输入 Q。' ;;
      esac
    done
  }

  install_fresh_instance() (
    local environment_overrides='DATA_ROOT|KNOWLEDGE_ROOT|AUTH_SECRET_FILE|APP_ORIGIN|PORT|HOST|VECTOR_RUNTIME_ROOT|MODEL_DIR|TOKENIZER_PYTHON|VECTOR_SERVICE_URL|VECTOR_SERVICE_TOKEN_FILE|EMBEDDING_SPACE_ID|AGENT_CONFIG_FILE'
    if [ "${DOOKNOW_NO_SERVICE:-0}" != 1 ]; then
      local user_environment
      user_environment="$(systemctl --user show-environment)" ||
        fail '无法读取 systemd 用户服务环境。请检查用户会话后再新建实例。'
      if grep -Eq "^($environment_overrides)=." <<<"$user_environment"; then
        fail 'systemd 用户环境中含有 DooKnow 路径或监听覆盖项，无法隔离新实例。请清除这些覆盖项，或以前台模式安装。'
      fi
    fi
    local instances="${XDG_DATA_HOME:-$HOME/.local/share}/doo-know-instances" fresh_root fresh_port
    make_directory '独立实例目录' "$instances"
    fresh_root="$(mktemp -d -- "$instances/instance-XXXXXXXX")" ||
      fail '无法创建独立实例目录。请检查数据目录的权限和磁盘空间。'
    fresh_root="$(readlink -f -- "$fresh_root")"
    fresh_port="$("$release/runtime/node/bin/node" --input-type=module -e '
      import { createServer } from "node:net";
      const probe = createServer();
      probe.listen(0, "127.0.0.1", () => {
        console.log(probe.address().port);
        probe.close();
      });
    ')" || fail '无法为新实例选择空闲端口。'
    [[ "$fresh_port" =~ ^[0-9]+$ ]] || fail '无法识别新实例的监听端口。'
    message '1;36' "$(printf '新实例目录 %q，访问地址 http://127.0.0.1:%s。' "$fresh_root" "$fresh_port")"
    message '33' '接下来设置新的账号，登录后即可创建知识库。旧实例的程序、账号和数据会保留。'
    unset DATA_ROOT KNOWLEDGE_ROOT AUTH_SECRET_FILE APP_ORIGIN PORT HOST VECTOR_RUNTIME_ROOT \
      MODEL_DIR TOKENIZER_PYTHON VECTOR_SERVICE_URL VECTOR_SERVICE_TOKEN_FILE EMBEDDING_SPACE_ID \
      AGENT_CONFIG_FILE DOOKNOW_APP_ORIGIN DOOKNOW_ALLOW_ROOT
    export XDG_CONFIG_HOME="$config_home" XDG_DATA_HOME="$fresh_root/share"
    export DOOKNOW_INSTALL_ROOT="$fresh_root/share/doo-know" DOOKNOW_PROFILE="$fresh_root/config/profile.json"
    export DOOKNOW_BIN_DIR="$fresh_root/bin" DOOKNOW_HOST=127.0.0.1 DOOKNOW_PORT="$fresh_port"
    export DOOKNOW_SERVICE_NAME="doo-know-${fresh_root##*/}.service" DOOKNOW_SOURCE="$source"
    main 8>&- 9>&-
  )

  local args=(install --install-root "$base" --profile "$profile")
  local github_repository=''
  if [[ "$source" =~ ^https://github\.com/([A-Za-z0-9-]+/[A-Za-z0-9_.-]+)/releases/download/([A-Za-z0-9.+-]+)$ ]]; then
    github_repository="${BASH_REMATCH[1]}"
    args+=(--github-repository "$github_repository")
    [ -z "${DOOKNOW_GITHUB_TOKEN_FILE:-}" ] || args+=(--github-token-file "$DOOKNOW_GITHUB_TOKEN_FILE")
  fi
  [ -z "${DOOKNOW_HOST:-}" ] || args+=(--host "$DOOKNOW_HOST")
  [ -z "${DOOKNOW_PORT:-}" ] || args+=(--port "$DOOKNOW_PORT")
  [ -z "${DOOKNOW_APP_ORIGIN:-}" ] || args+=(--origin "$DOOKNOW_APP_ORIGIN")
  [ -z "${DOOKNOW_ALLOW_ROOT:-}" ] || args+=(--allow-root "$DOOKNOW_ALLOW_ROOT")
  [ -z "${DOOKNOW_SERVICE_NAME:-}" ] || args+=(--service-name "$DOOKNOW_SERVICE_NAME")
  [ "${DOOKNOW_NO_SERVICE:-0}" != 1 ] || args+=(--no-service)
  local current=''
  if [ -L "$base/current" ]; then
    current="$(readlink -f -- "$base/current")" ||
      fail "$(printf '无法解析当前版本链接 %q。请核对安装目录中的版本和升级记录，并先保留现有文件。' "$base/current")"
    if [ -z "$github_repository" ] && [ ! -d "$current" ]; then
      fail "$(printf '当前版本目录 %q 不存在或无法访问。请核对安装目录中的版本和升级记录，并先保留现有文件。' "$current")"
    fi
  fi
  if [ -n "$current" ] && [ "$current" != "$release" ]; then
    local update_args=(update --source "$source" --version "$version" --install-root "$base" --profile "$profile")
    local manager_root="$current" update_status choice
    [ "${DOOKNOW_NO_SERVICE:-0}" != 1 ] || update_args+=(--no-service)
    if [ -n "$github_repository" ]; then
      manager_root="$release"
      update_args+=(--github-repository "$github_repository")
      [ -z "${DOOKNOW_GITHUB_TOKEN_FILE:-}" ] || update_args+=(--github-token-file "$DOOKNOW_GITHUB_TOKEN_FILE")
    fi
    if [ ! -e "$launcher" ] && [ -n "${bound_profile:-}" ] && [[ "$current" == "$base/releases/"* ]] &&
      [ -x "$current/runtime/node/bin/node" ] && [ -f "$current/dist/server/scripts/manage.js" ]; then
      publish_launcher
      message '1;32' "已恢复旧实例的管理命令 $launcher。"
    fi
    while true; do
      update_status=0
      NODE_OPTIONS="$node_options" DOOKNOW_INSTALL_WIZARD=1 "$manager_root/runtime/node/bin/node" \
        "$manager_root/dist/server/scripts/manage.js" "${update_args[@]}" || update_status=$?
      if [ "$update_status" -eq 0 ]; then break; fi
      if [ "$update_status" -ne 42 ]; then
        fail '发现已有实例，升级未完成。请查看上方原因，并保留配置、备份、版本目录及升级记录。'
      fi
      if [ "$tty_available" -ne 1 ]; then
        fail '旧知识库暂不可用。请恢复原目录后重试，或在交互终端重跑安装向导并选择新建独立实例。'
      fi
      choice=0
      choose_new_instance || choice=$?
      case "$choice" in
        0)
          reported=1
          install_fresh_instance
          return
          ;;
        2)
          message '33' '已退出安装向导。以后可重跑原安装命令。'
          reported=1
          exit 1
          ;;
      esac
    done
  else
    local node="$release/runtime/node/bin/node" manager="$release/dist/server/scripts/manage.js"
    if [ "$tty_available" -eq 1 ]; then
      NODE_OPTIONS="$node_options" "$node" "$manager" "${args[@]}" </dev/tty ||
        fail '安装包已解包，账号或服务设置可能已写入，安装器尚未完成管理命令入口的发布。请处理上方错误后重跑原安装命令。'
    else
      NODE_OPTIONS="$node_options" "$node" "$manager" "${args[@]}" ||
        fail '安装包已解包，安装器尚未完成管理命令入口的发布。' \
          '若上方提示需要交互输入，请在运行 DooKnow 的用户终端重跑完整安装命令。其他错误请先按上方诊断处理。'
    fi
    ln -s "releases/$version" "$work/current" && mv -Tf -- "$work/current" "$base/current" ||
      fail "$(printf '初始化已完成，但无法发布当前版本链接 %q。请检查安装目录权限后重跑原安装命令。' "$base/current")"
  fi
  # Publish ownership only after initialization has created the profile. A
  # missing profile in an already-bound installation must never be recreated.
  if [ -e "$base/profile.path" ] || [ -L "$base/profile.path" ]; then
    check_profile_binding
  else
    printf '%s\n' "$profile" > "$work/profile.path" &&
      ln -- "$work/profile.path" "$base/profile.path" &&
      rm -- "$work/profile.path" ||
      fail "$(printf '程序已就绪，但无法写入配置归属记录 %q。请检查目录权限，并核对是否有其他安装在操作同一目录。' "$base/profile.path")"
  fi
  publish_launcher
  printf '管理命令路径：%s\n\n' "$launcher"
)
main "$@"
