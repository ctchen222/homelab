#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${1:-"${SCRIPT_DIR}/.env"}"
ASSISTANT_PORT="${ASSISTANT_PORT:-8090}"
LOG_FILE="${LOG_FILE:-/private/tmp/finops-ngrok.log}"
NGROK_TMP_DIR="${NGROK_TMP_DIR:-/private/tmp/finops-ngrok-bin}"
NGROK_TMP_BIN="${NGROK_TMP_DIR}/ngrok"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Missing env file: ${ENV_FILE}" >&2
  exit 1
fi

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

read_env() {
  awk -F= -v key="$1" '$1 == key { print substr($0, index($0, "=") + 1); exit }' "${ENV_FILE}"
}

version_ok() {
  local version="$1"
  local major minor patch
  IFS=. read -r major minor patch <<<"${version}"
  [[ "${major:-0}" -gt 3 ]] || [[ "${major:-0}" -eq 3 && "${minor:-0}" -ge 20 ]]
}

ngrok_version() {
  "$1" version | awk '{ print $3 }'
}

download_ngrok() {
  local os arch url
  os="$(uname -s)"
  arch="$(uname -m)"

  if [[ "${os}" != "Darwin" || "${arch}" != "arm64" ]]; then
    echo "Automatic ngrok download only supports Darwin arm64 in this script." >&2
    echo "Install ngrok >= 3.20 manually, then rerun this script." >&2
    exit 1
  fi

  url="https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-darwin-arm64.zip"
  mkdir -p "${NGROK_TMP_DIR}"
  curl -fsSL "${url}" -o "${NGROK_TMP_DIR}/ngrok.zip"
  unzip -o "${NGROK_TMP_DIR}/ngrok.zip" -d "${NGROK_TMP_DIR}" >/dev/null
  chmod +x "${NGROK_TMP_BIN}"
}

select_ngrok() {
  if [[ -x "${NGROK_TMP_BIN}" ]] && version_ok "$(ngrok_version "${NGROK_TMP_BIN}")"; then
    echo "${NGROK_TMP_BIN}"
    return
  fi

  if command -v ngrok >/dev/null 2>&1 && version_ok "$(ngrok_version "$(command -v ngrok)")"; then
    command -v ngrok
    return
  fi

  echo "ngrok >= 3.20 not found; downloading latest stable binary to ${NGROK_TMP_DIR}" >&2
  download_ngrok
  echo "${NGROK_TMP_BIN}"
}

require_command awk
require_command curl
require_command jq
require_command unzip

BOT_TOKEN="$(read_env TELEGRAM_BOT_TOKEN)"
WEBHOOK_SECRET="$(read_env TELEGRAM_WEBHOOK_SECRET)"

if [[ -z "${BOT_TOKEN}" || -z "${WEBHOOK_SECRET}" ]]; then
  echo "TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET must be set in ${ENV_FILE}" >&2
  exit 1
fi

NGROK_BIN="$(select_ngrok)"
rm -f "${LOG_FILE}"

"${NGROK_BIN}" http "${ASSISTANT_PORT}" --log=stdout --log-format=logfmt >"${LOG_FILE}" 2>&1 &
NGROK_PID="$!"

cleanup() {
  if kill -0 "${NGROK_PID}" >/dev/null 2>&1; then
    kill "${NGROK_PID}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

PUBLIC_URL=""
for _ in $(seq 1 30); do
  if ! kill -0 "${NGROK_PID}" >/dev/null 2>&1; then
    echo "ngrok exited before a tunnel was ready. Log:" >&2
    tail -n 80 "${LOG_FILE}" >&2 || true
    exit 1
  fi

  PUBLIC_URL="$(curl -fsS http://127.0.0.1:4040/api/tunnels 2>/dev/null | jq -r '.tunnels[]? | select(.proto == "https") | .public_url' | head -n 1 || true)"
  if [[ -n "${PUBLIC_URL}" && "${PUBLIC_URL}" != "null" ]]; then
    break
  fi
  sleep 1
done

if [[ -z "${PUBLIC_URL}" || "${PUBLIC_URL}" == "null" ]]; then
  echo "Timed out waiting for ngrok public URL. Log:" >&2
  tail -n 80 "${LOG_FILE}" >&2 || true
  exit 1
fi

WEBHOOK_URL="${PUBLIC_URL}/telegram/webhook"
curl -fsS -X POST "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
  --data-urlencode "url=${WEBHOOK_URL}" \
  --data-urlencode "secret_token=${WEBHOOK_SECRET}" \
  --data-urlencode 'allowed_updates=["message","edited_message","callback_query"]' \
  -d "drop_pending_updates=true" >/dev/null

echo "ngrok URL: ${PUBLIC_URL}"
echo "Telegram webhook: ${WEBHOOK_URL}"
echo "ngrok log: ${LOG_FILE}"
echo "Keep this process running while testing. Press Ctrl-C to stop the tunnel."

wait "${NGROK_PID}"
