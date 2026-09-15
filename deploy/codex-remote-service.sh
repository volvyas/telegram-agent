#!/usr/bin/env bash
set -euo pipefail

readonly SERVICE_NAME="codex-remote.service"
readonly SCRIPT_DIRECTORY="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly PROJECT_ROOT="$(cd -- "${SCRIPT_DIRECTORY}/.." && pwd -P)"
readonly UNIT_TEMPLATE="${SCRIPT_DIRECTORY}/codex-remote.service"
readonly SYSTEM_UNIT="/etc/systemd/system/${SERVICE_NAME}"

usage() {
  cat <<'EOF'
Usage:
  sudo --preserve-env=PATH ./deploy/codex-remote-service.sh install <user> [node-binary]
  ./deploy/codex-remote-service.sh render <user> [node-binary]
  sudo ./deploy/codex-remote-service.sh uninstall
  sudo ./deploy/codex-remote-service.sh start|stop|restart
  ./deploy/codex-remote-service.sh status|logs

The install command renders a systemd unit for this checkout, installs it in
/etc/systemd/system, enables it, and starts it. The service user must be a
non-root local account with access to this checkout, CODEX_HOME, and every
configured repository.
EOF
}

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

require_root() {
  [[ "${EUID}" -eq 0 ]] || fail "this action must be run through sudo or as root"
}

resolve_node_binary() {
  local configured="${1:-}"
  if [[ -n "${configured}" ]]; then
    [[ "${configured}" = /* ]] || fail "node-binary must be an absolute path"
    printf '%s\n' "${configured}"
    return
  fi

  local discovered
  discovered="$(command -v node || true)"
  [[ -n "${discovered}" ]] || fail "node was not found; pass its absolute path"
  [[ "${discovered}" = /* ]] || fail "resolved node binary is not absolute"
  printf '%s\n' "${discovered}"
}

validate_render_inputs() {
  local service_user="$1"
  local node_binary="$2"

  [[ "${service_user}" =~ ^[a-z_][a-z0-9_-]*[$]?$ ]] || fail "invalid service user"
  id "${service_user}" >/dev/null 2>&1 || fail "service user does not exist"
  [[ "$(id -u "${service_user}")" -ne 0 ]] || fail "the service must not run as root"
  [[ -x "${node_binary}" ]] || fail "node binary is not executable"
  [[ -r "${UNIT_TEMPLATE}" ]] || fail "systemd unit template is missing"
  [[ -r "${PROJECT_ROOT}/dist/index.js" ]] || fail "dist/index.js is missing; run npm run build"
  [[ -r "${PROJECT_ROOT}/.env" ]] || fail ".env is missing or unreadable"
  [[ "${PROJECT_ROOT}" != *%* && "${node_binary}" != *%* ]] || \
    fail "paths containing % are not supported by the systemd template"
  [[ ! "${PROJECT_ROOT}" =~ [[:space:]\\\"] ]] || \
    fail "checkout paths containing whitespace, backslash, or quotes are not supported"
  [[ ! "${node_binary}" =~ [[:space:]\\\"] ]] || \
    fail "node paths containing whitespace, backslash, or quotes are not supported"

  if [[ "${EUID}" -eq 0 ]] && command -v runuser >/dev/null 2>&1; then
    runuser -u "${service_user}" -- test -r "${PROJECT_ROOT}/dist/index.js" || \
      fail "service user cannot read dist/index.js"
    runuser -u "${service_user}" -- test -r "${PROJECT_ROOT}/.env" || \
      fail "service user cannot read .env"
    runuser -u "${service_user}" -- test -x "${node_binary}" || \
      fail "service user cannot execute node"
  elif [[ "$(id -u "${service_user}")" -eq "${EUID}" ]]; then
    [[ -r "${PROJECT_ROOT}/dist/index.js" ]] || fail "cannot read dist/index.js"
    [[ -r "${PROJECT_ROOT}/.env" ]] || fail "cannot read .env"
  else
    fail "render for another user must be run as root to verify file access"
  fi
}

escape_sed_replacement() {
  printf '%s' "$1" | sed 's/[\&|]/\\&/g'
}

render_unit() {
  local service_user="$1"
  local node_binary="$2"
  local node_directory="${node_binary%/*}"
  local escaped_user escaped_root escaped_node escaped_node_directory

  validate_render_inputs "${service_user}" "${node_binary}"
  escaped_user="$(escape_sed_replacement "${service_user}")"
  escaped_root="$(escape_sed_replacement "${PROJECT_ROOT}")"
  escaped_node="$(escape_sed_replacement "${node_binary}")"
  escaped_node_directory="$(escape_sed_replacement "${node_directory}")"

  sed \
    -e "s|@@SERVICE_USER@@|${escaped_user}|g" \
    -e "s|@@PROJECT_ROOT@@|${escaped_root}|g" \
    -e "s|@@NODE_BINARY@@|${escaped_node}|g" \
    -e "s|@@NODE_DIRECTORY@@|${escaped_node_directory}|g" \
    "${UNIT_TEMPLATE}"
}

action="${1:-}"
case "${action}" in
  install)
    require_root
    service_user="${2:-${SUDO_USER:-}}"
    [[ -n "${service_user}" ]] || fail "pass the non-root service user"
    node_binary="$(resolve_node_binary "${3:-}")"
    chmod 600 "${PROJECT_ROOT}/.env"
    render_unit "${service_user}" "${node_binary}" | \
      install -o root -g root -m 0644 /dev/stdin "${SYSTEM_UNIT}"
    systemctl daemon-reload
    systemctl enable --now "${SERVICE_NAME}"
    systemctl --no-pager --full status "${SERVICE_NAME}"
    ;;
  render)
    service_user="${2:-$(id -un)}"
    node_binary="$(resolve_node_binary "${3:-}")"
    render_unit "${service_user}" "${node_binary}"
    ;;
  uninstall)
    require_root
    systemctl disable --now "${SERVICE_NAME}" 2>/dev/null || true
    if [[ -e "${SYSTEM_UNIT}" ]]; then
      rm -- "${SYSTEM_UNIT}"
    fi
    systemctl daemon-reload
    ;;
  start|stop|restart)
    require_root
    systemctl "${action}" "${SERVICE_NAME}"
    ;;
  status)
    systemctl --no-pager --full status "${SERVICE_NAME}"
    ;;
  logs)
    exec journalctl -u "${SERVICE_NAME}" -f
    ;;
  help|-h|--help)
    usage
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
