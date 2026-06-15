#!/usr/bin/env bash

set -euo pipefail

: "${BOT_TOKEN:?BOT_TOKEN is required}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "required command missing: $1" >&2
    exit 1
  fi
}

require_cmd curl
require_cmd jq

WEBHOOK_INFO_URL="https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo"
RESPONSE=$(curl -fsS "${WEBHOOK_INFO_URL}")
ALLOW_UPDATES=$(echo "${RESPONSE}" | jq -r '.result.allowed_updates // [] | .[]')

if ! echo "${RESPONSE}" | jq -e '.ok == true and .result.url != null' >/dev/null; then
  echo "Webhook info verification failed: Telegram did not return a valid webhook." >&2
  echo "${RESPONSE}" >&2
  exit 1
fi

if ! echo "${ALLOW_UPDATES}" | grep -Fxq "callback_query"; then
  echo "Webhook verification failed: callback_query is missing from allowed_updates." >&2
  echo "Current allowed_updates: $(echo "${RESPONSE}" | jq -c '.result.allowed_updates')" >&2
  exit 1
fi

echo "Webhook verification OK."
echo "${RESPONSE}" | jq -r '{url: .result.url, pending_update_count: .result.pending_update_count, allowed_updates: .result.allowed_updates}'
