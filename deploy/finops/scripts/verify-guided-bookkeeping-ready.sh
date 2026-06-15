#!/usr/bin/env bash

set -euo pipefail

: "${EBK_API_BASE_URL:?EBK_API_BASE_URL is required}"
: "${EBK_API_TOKEN:?EBK_API_TOKEN is required}"
: "${BOT_TOKEN:?BOT_TOKEN is required for callback support check}"

REQUIRED_MIN_ACCOUNTS="${GUIDED_FLOW_MIN_ACCOUNTS:-1}"
BASE_URL="${EBK_API_BASE_URL%/}"
ACCOUNT_MIN_VISIBLE="${GUIDED_FLOW_MIN_VISIBLE_ACCOUNTS:-1}"

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required." >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required." >&2
  exit 1
fi

fetch_with_auth() {
  local endpoint="$1"
  curl -fsS -H "Authorization: Bearer ${EBK_API_TOKEN}" "${BASE_URL}${endpoint}"
}

echo "== Guided flow prerequisite check =="

ACCOUNTS_RESPONSE=$(fetch_with_auth "/api/v1/accounts/list.json")
if ! echo "${ACCOUNTS_RESPONSE}" | jq -e '.ok == true or .success == true' >/dev/null; then
  echo "Account list check failed: unexpected response." >&2
  echo "${ACCOUNTS_RESPONSE}" >&2
  exit 1
fi

ACCOUNT_COUNT=$(echo "${ACCOUNTS_RESPONSE}" | jq '[.result // [] | .[]] | length')
USABLE_ACCOUNT_COUNT=$(echo "${ACCOUNTS_RESPONSE}" | jq '[.result // [] | .[] | select(.disabled != true) ] | length')
VISIBLE_ACCOUNT_COUNT=$(echo "${ACCOUNTS_RESPONSE}" | jq '[.result // [] | .[] | select((.disabled != true) and (.hidden != true))] | length')
if [ "${ACCOUNT_COUNT}" -lt "${REQUIRED_MIN_ACCOUNTS}" ]; then
  echo "Account list check failed: expected at least ${REQUIRED_MIN_ACCOUNTS} account, found ${ACCOUNT_COUNT}." >&2
  exit 1
fi
if [ "${USABLE_ACCOUNT_COUNT}" -lt "${ACCOUNT_MIN_VISIBLE}" ]; then
  echo "Usable account check failed: expected at least ${ACCOUNT_MIN_VISIBLE} enabled account, found ${USABLE_ACCOUNT_COUNT}." >&2
  exit 1
fi
if [ "${VISIBLE_ACCOUNT_COUNT}" -lt "${ACCOUNT_MIN_VISIBLE}" ]; then
  echo "Visible account check failed: expected at least ${ACCOUNT_MIN_VISIBLE} enabled and non-hidden account, found ${VISIBLE_ACCOUNT_COUNT}." >&2
  exit 1
fi

echo "Accounts OK: ${ACCOUNT_COUNT} total, ${USABLE_ACCOUNT_COUNT} enabled, ${VISIBLE_ACCOUNT_COUNT} enabled+visible account(s)."

EXPENSE_CATEGORIES_RESPONSE=$(fetch_with_auth "/api/v1/transaction/categories/list.json?type=2")
if ! echo "${EXPENSE_CATEGORIES_RESPONSE}" | jq -e '.ok == true or .success == true' >/dev/null; then
  echo "Expense category check failed: unexpected response." >&2
  echo "${EXPENSE_CATEGORIES_RESPONSE}" >&2
  exit 1
fi

EXPENSE_CATEGORY_COUNT=$(echo "${EXPENSE_CATEGORIES_RESPONSE}" | jq '[.result["2"] // [] | .. | objects | .id] | length')
if [ "${EXPENSE_CATEGORY_COUNT}" -le 0 ]; then
  echo "Expense category check warning: no expense categories found yet. Guided flow will still work via category add." >&2
else
  echo "Expense categories OK: ${EXPENSE_CATEGORY_COUNT} entry(ies)."
fi

WEBHOOK_INFO_URL="https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo"
RESPONSE=$(curl -fsS "${WEBHOOK_INFO_URL}")
if ! echo "${RESPONSE}" | jq -e '.ok == true and .result.url != null' >/dev/null; then
  echo "Webhook check failed: Telegram webhook info unavailable." >&2
  echo "${RESPONSE}" >&2
  exit 1
fi

if ! echo "${RESPONSE}" | jq -e '.result.allowed_updates | index("callback_query")' >/dev/null; then
  echo "Webhook check failed: callback_query missing from allowed_updates." >&2
  echo "${RESPONSE}" | jq -c '{url: .result.url, allowed_updates: .result.allowed_updates}'
  exit 1
fi

echo "Webhook callback support OK."
echo "Guided flow prerequisites look healthy."
