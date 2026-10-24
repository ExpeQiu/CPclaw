#!/bin/bash
# 被 start.sh / stop.sh / verify.sh source。不要直接执行。

cpclaw_root() {
  cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd
}

cpclaw_load_dotenv() {
  local file="$1"
  local line key
  [[ -f "$file" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    case "$line" in
      ""|\#*) continue ;;
    esac
    case "$line" in
      *=*) ;;
      *) continue ;;
    esac
    key="${line%%=*}"
    case "$key" in
      AI_MOCK_MODE|CPCLAW_REPORT_ENGINE|CPCLAW_HARNESS_ROOT|CPCLAW_REPORT_MODEL_MODE|CPCLAW_DATA_DIR|CPCLAW_DEV_HOST_PORT|CPCLAW_PLATFORM_PORT|CPCLAW_LISTEN_HOST|CPCLAW_PLATFORM_URL|CPCLAW_SESSION_SECRET|CPCLAW_PLATFORM_SEED|CPCLAW_BOOTSTRAP_FILE|CPCLAW_ACCESS_TTL_SEC|CPCLAW_REFRESH_TTL_SEC|CPCLAW_REMOTE_HOST|CPCLAW_REMOTE_USER|CPCLAW_REMOTE_DIR|CPCLAW_FIREWALL_ACK|CPCLAW_FIREWALL_SOURCE_IP) ;;
      *) continue ;;
    esac
    if [[ -z "${!key+x}" ]]; then
      printf -v "$key" "%s" "${line#*=}"
      export "$key"
    fi
  done < "$file"
}

cpclaw_require_runtime() {
  local node_version pnpm_version
  if ! command -v node >/dev/null 2>&1; then
    echo "未找到 node" >&2
    return 1
  fi
  node_version="$(node -v)"
  if [[ "$node_version" != "v22.23.3" ]]; then
    echo "当前增量只在 Node.js v22.23.3 上验证，实际是 ${node_version}" >&2
    return 1
  fi
  if ! command -v pnpm >/dev/null 2>&1; then
    echo "未找到 pnpm" >&2
    return 1
  fi
  pnpm_version="$(pnpm -v)"
  if [[ "$pnpm_version" != "9.0.0" ]]; then
    echo "当前增量只在 pnpm 9.0.0 上验证，实际是 ${pnpm_version}" >&2
    return 1
  fi
}

cpclaw_build() {
  local root="$1"
  if [[ -f "$root/pnpm-lock.yaml" ]]; then
    (cd "$root" && CI=true pnpm install --frozen-lockfile && pnpm --filter "./packages/*" --if-present run build)
  else
    (cd "$root" && CI=true pnpm install && pnpm --filter "./packages/*" --if-present run build)
  fi
}

cpclaw_pid_is_ours() {
  local pid="$1"
  local cmd
  cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  case "$cmd" in
    *scripts/dev-host.mjs*) return 0 ;;
    *) return 1 ;;
  esac
}

cpclaw_pid_is_platform() {
  local pid="$1"
  local cmd
  cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  case "$cmd" in
    *scripts/platform-host.mjs*) return 0 ;;
    *) return 1 ;;
  esac
}

# 若设置了 CPCLAW_PLATFORM_URL，则健康检查远程平台；空字符串拒绝。未设置则跳过。
cpclaw_remote_platform_preflight() {
  local root="$1"
  if [[ -z "${CPCLAW_PLATFORM_URL+x}" ]]; then
    return 0
  fi
  if [[ "${CPCLAW_PLATFORM_URL}" == "" ]]; then
    echo "CPCLAW_PLATFORM_URL 为空字符串，不会回落到本机平台" >&2
    return 1
  fi
  local url_env base mode
  url_env="$(cd "$root" && node scripts/resolve-platform-url.mjs)"
  base="$(printf "%s\n" "$url_env" | awk -F= '/^CPCLAW_PLATFORM_BASE=/{print substr($0, index($0, "=")+1)}')"
  mode="$(printf "%s\n" "$url_env" | awk -F= '/^CPCLAW_PLATFORM_MODE=/{print substr($0, index($0, "=")+1)}')"
  base="${base//\'/}"
  mode="${mode//\'/}"
  if [[ "$mode" != "remote" ]]; then
    echo "期望远程平台，实际 mode=${mode}" >&2
    return 1
  fi
  echo "远程平台预检 ${base}"
  curl -fsS --max-time 5 "${base}/health" | node "$root/scripts/check-platform-health.mjs"
}
