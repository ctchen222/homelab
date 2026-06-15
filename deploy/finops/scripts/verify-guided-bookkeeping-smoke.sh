#!/usr/bin/env bash

set -euo pipefail

: "${ASSISTANT_WEBHOOK_URL:?ASSISTANT_WEBHOOK_URL is required (例如 https://finops-assistant.../telegram/webhook)}"
: "${ASSISTANT_WEBHOOK_SECRET:?ASSISTANT_WEBHOOK_SECRET is required for webhook callback assertion}"
: "${EBK_API_BASE_URL:?EBK_API_BASE_URL is required}"
: "${EBK_API_TOKEN:?EBK_API_TOKEN is required}"
: "${GUIDED_SMOKE_USER_ID:?GUIDED_SMOKE_USER_ID is required}"
: "${GUIDED_SMOKE_CHAT_ID:?GUIDED_SMOKE_CHAT_ID is required}"

ASSISTANT_WEBHOOK_URL="${ASSISTANT_WEBHOOK_URL%/}"
EBK_API_BASE_URL="${EBK_API_BASE_URL%/}"

ASSISTANT_WEBHOOK_SECRET_HEADER="X-Telegram-Bot-Api-Secret-Token: ${ASSISTANT_WEBHOOK_SECRET}"

GUIDED_SMOKE_AMOUNT="${GUIDED_SMOKE_AMOUNT:-120}"
GUIDED_SMOKE_MARKER_PREFIX="${GUIDED_SMOKE_MARKER_PREFIX:-SMOKE_TEST_GUIDED_FLOW}"
GUIDED_SMOKE_WAIT_SECONDS="${GUIDED_SMOKE_WAIT_SECONDS:-2}"
GUIDED_SMOKE_ATTEMPTS="${GUIDED_SMOKE_ATTEMPTS:-8}"
GUIDED_SMOKE_MANUAL_FALLBACK="${GUIDED_SMOKE_MANUAL_FALLBACK:-1}"

GUIDED_SMOKE_DB_NAMESPACE="${GUIDED_SMOKE_DB_NAMESPACE:-finops}"
GUIDED_SMOKE_DB_POD_SELECTOR="${GUIDED_SMOKE_DB_POD_SELECTOR:-app.kubernetes.io/component=assistant}"
GUIDED_SMOKE_DB_PATH="${GUIDED_SMOKE_DB_PATH:-/data/assistant.sqlite}"
GUIDED_SMOKE_KUBECTL_CONTEXT="${KUBECTL_CONTEXT:-furfriend-vps}"

GUIDED_SMOKE_DELETE_ENDPOINT="${GUIDED_SMOKE_DELETE_ENDPOINT:-}"

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required." >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required." >&2
  exit 1
fi

log() {
  printf '[%s] %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$*"
}

fetch_transaction_count() {
  if ! curl -fsS -H "Authorization: Bearer ${EBK_API_TOKEN}" "${EBK_API_BASE_URL}/api/v1/transactions/list/all.json" > /tmp/guided-bookkeeping-smoke.transactions.json; then
    echo "Failed to read transaction list." >&2
    return 1
  fi

  if ! jq -e '.ok == true or .success == true' /tmp/guided-bookkeeping-smoke.transactions.json >/dev/null 2>&1; then
    echo "Transaction list API returned unexpected response." >&2
    cat /tmp/guided-bookkeeping-smoke.transactions.json >&2
    return 1
  fi

  jq '[.result // [] | .[]] | length' /tmp/guided-bookkeeping-smoke.transactions.json
}

query_draft_id() {
  local user_id="$1"
  local chat_id="$2"

  local pod
  pod=""
  if ! command -v kubectl >/dev/null 2>&1; then
    return 1
  fi

  pod=$(kubectl --context "${GUIDED_SMOKE_KUBECTL_CONTEXT}" -n "${GUIDED_SMOKE_DB_NAMESPACE}" get pod -l "${GUIDED_SMOKE_DB_POD_SELECTOR}" -o jsonpath='{.items[0].metadata.name}')
  if [[ -z "${pod}" ]]; then
    return 1
  fi

  if ! kubectl --context "${GUIDED_SMOKE_KUBECTL_CONTEXT}" -n "${GUIDED_SMOKE_DB_NAMESPACE}" exec "$pod" -- sh -lc "command -v python3 >/dev/null 2>&1" >/dev/null 2>&1; then
    return 1
  fi

  local script
  script=$(cat <<'PY'
import sqlite3, json, sys
path = sys.argv[1]
user_id = int(sys.argv[2])
chat_id = int(sys.argv[3])
conn = sqlite3.connect(path)
cur = conn.cursor()
row = cur.execute(
    "SELECT draft_id, category_id, account_id FROM bookkeeping_drafts WHERE user_id=? AND chat_id=? AND status='active' ORDER BY created_at DESC LIMIT 1",
    (user_id, chat_id),
).fetchone()
if row:
    print(json.dumps({"draft_id": row[0], "category_id": row[1], "account_id": row[2]}))
else:
    print("", end="")
PY
)

  if ! kubectl --context "${GUIDED_SMOKE_KUBECTL_CONTEXT}" -n "${GUIDED_SMOKE_DB_NAMESPACE}" exec "$pod" -- python3 - "$GUIDED_SMOKE_DB_PATH" "$user_id" "$chat_id" <<<"${script}" > /tmp/guided-bookkeeping-smoke.draft.json 2>/tmp/guided-bookkeeping-smoke.draft.err; then
    return 1
  fi
  if ! jq -e '.draft_id | length > 0' /tmp/guided-bookkeeping-smoke.draft.json >/dev/null 2>&1; then
    return 1
  fi
  cat /tmp/guided-bookkeeping-smoke.draft.json
}

post_webhook_update() {
  local payload="$1"
  curl -fsS -H "${ASSISTANT_WEBHOOK_SECRET_HEADER}" -H "Content-Type: application/json" \
    -X POST "${ASSISTANT_WEBHOOK_URL}" \
    --data-raw "${payload}"
}

send_webhook_callback() {
  local payload="$1"
  curl -fsS -H "${ASSISTANT_WEBHOOK_SECRET_HEADER}" -H "Content-Type: application/json" \
    -X POST "${ASSISTANT_WEBHOOK_URL}" \
    --data-raw "${payload}"
}

delete_transaction_via_api() {
  local tx_id="$1"
  local delete_payload
  delete_payload=$(jq -cn --arg id "${tx_id}" '{id: $id, transactionId: $id}')

  if [[ -n "${GUIDED_SMOKE_DELETE_ENDPOINT}" ]]; then
    local endpoint="${GUIDED_SMOKE_DELETE_ENDPOINT}"
    if curl -fsS -X POST -H "Authorization: Bearer ${EBK_API_TOKEN}" -H "Content-Type: application/json" -d "${delete_payload}" "${EBK_API_BASE_URL}${endpoint}" >/dev/null 2>&1; then
      return 0
    fi
  else
    local endpoint
    for endpoint in "/api/v1/transactions/delete.json" "/api/v1/transactions/remove.json" "/api/v1/transaction/delete.json" "/api/v1/transaction/remove.json"; do
      if curl -fsS -X POST -H "Authorization: Bearer ${EBK_API_TOKEN}" -H "Content-Type: application/json" -d "${delete_payload}" "${EBK_API_BASE_URL}${endpoint}" >/tmp/guided-bookkeeping-smoke.delete.out 2>/tmp/guided-bookkeeping-smoke.delete.err; then
        return 0
      fi
    done
  fi

  return 1
}

find_account_id() {
  local draft_json="$1"
  local account_id
  account_id=$(echo "${draft_json}" | jq -r '.account_id // empty')
  if [[ -n "${account_id}" ]]; then
    echo "${account_id}"
    return 0
  fi

  if ! curl -fsS -H "Authorization: Bearer ${EBK_API_TOKEN}" "${EBK_API_BASE_URL}/api/v1/accounts/list.json" > /tmp/guided-bookkeeping-smoke.accounts.json; then
    return 1
  fi
  jq -r '[.result // [] | .[] | select((.disabled != true) and (.hidden != true) and .id) | .id][0] // empty' /tmp/guided-bookkeeping-smoke.accounts.json
}

find_category_id() {
  local draft_json="$1"
  local draft_id category_id
  category_id=$(echo "${draft_json}" | jq -r '.category_id // empty')
  if [[ -n "${category_id}" ]]; then
    echo "${category_id}"
    return 0
  fi

  if ! curl -fsS -H "Authorization: Bearer ${EBK_API_TOKEN}" "${EBK_API_BASE_URL}/api/v1/transaction/categories/list.json?type=2" > /tmp/guided-bookkeeping-smoke.categories.json; then
    return 1
  fi
  jq -r '[.result["2"] // [] | .. | objects | select(.id and .parentId != "0") | .id][0] // empty' /tmp/guided-bookkeeping-smoke.categories.json
}

log "1/5 取得測試前交易數"
BASE_COUNT=$(fetch_transaction_count)
log "目前交易數=${BASE_COUNT}"

TIMESTAMP=$(date +%Y%m%dT%H%M%S)
MARKER="${GUIDED_SMOKE_MARKER_PREFIX}-${TIMESTAMP}-${RANDOM}"
TEXT="lunch ${GUIDED_SMOKE_AMOUNT} ${MARKER}"
UPDATE_ID_BASE=${RANDOM:-100}
UPDATE_ID_MESSAGE=$((200000000 + UPDATE_ID_BASE))

log "2/5 透過 webhook 提交 quick sentence：${TEXT}"
MESSAGE_PAYLOAD=$(jq -cn \
  --argjson update_id "${UPDATE_ID_MESSAGE}" \
  --argjson date "$(date +%s)" \
  --argjson chat_id "${GUIDED_SMOKE_CHAT_ID}" \
  --argjson user_id "${GUIDED_SMOKE_USER_ID}" \
  --arg text "${TEXT}" \
  '{
    update_id: $update_id,
    message: {
      message_id: 1,
      date: $date,
      chat: { id: $chat_id, type: "private" },
      from: { id: $user_id, is_bot: false, first_name: "Smoke" },
      text: $text
    }
  }')

post_webhook_update "${MESSAGE_PAYLOAD}" >/tmp/guided-bookkeeping-smoke.webhook.out

sleep "${GUIDED_SMOKE_WAIT_SECONDS}"

if ! DRAFT_JSON=$(query_draft_id "${GUIDED_SMOKE_USER_ID}" "${GUIDED_SMOKE_CHAT_ID}"); then
  if [[ "${GUIDED_SMOKE_MANUAL_FALLBACK}" != "1" ]]; then
    log "草稿無法自動定位，請改為人工完成按鈕流程。"
    log "訊息內容：${TEXT}，請在 Telegram 按照以下步驟完成：選分類、選帳戶、按 Confirm。"
    log "完成後回到此腳本輸入回歸檢查。"
    exit 1
  fi
  log "草稿未自動定位，改走人工 fallback：請在 Telegram 完成分類/帳戶/Confirm。"
  log "完成後本腳本會繼續監測交易是否增加並嘗試回滾。"
  if [[ -t 0 ]]; then
    read -r -p "完成後按 Enter 繼續... " _
  fi
fi

if [[ -n "${DRAFT_JSON:-}" ]]; then
  log "3/5 以 callback query 自動完成分類與帳戶"
  DRAFT_ID=$(echo "${DRAFT_JSON}" | jq -r '.draft_id')
  CATEGORY_ID=$(find_category_id "${DRAFT_JSON}")
  ACCOUNT_ID=$(find_account_id "${DRAFT_JSON}")

  if [[ -z "${CATEGORY_ID}" || -z "${ACCOUNT_ID}" ]]; then
    log "無法自動解析分類或帳戶，改以人工流程完成。"
  else
    UPDATE_ID_CATEGORY=$((UPDATE_ID_MESSAGE + 1))
    UPDATE_ID_ACCOUNT=$((UPDATE_ID_MESSAGE + 2))
    UPDATE_ID_CONFIRM=$((UPDATE_ID_MESSAGE + 3))

    CATEGORY_PAYLOAD=$(jq -cn \
      --argjson update_id "${UPDATE_ID_CATEGORY}" \
      --arg callback_id "cb-${UPDATE_ID_CATEGORY}" \
      --argjson user_id "${GUIDED_SMOKE_USER_ID}" \
      --argjson chat_id "${GUIDED_SMOKE_CHAT_ID}" \
      --arg data "finops:d:${DRAFT_ID}:select_category:${CATEGORY_ID}" \
      '{
        update_id: $update_id,
        callback_query: {
          id: $callback_id,
          from: { id: $user_id, is_bot: false, first_name: "Smoke" },
          message: { message_id: 1, chat: { id: $chat_id } },
          data: $data
        }
      }')

    ACCOUNT_PAYLOAD=$(jq -cn \
      --argjson update_id "${UPDATE_ID_ACCOUNT}" \
      --arg callback_id "cb-${UPDATE_ID_ACCOUNT}" \
      --argjson user_id "${GUIDED_SMOKE_USER_ID}" \
      --argjson chat_id "${GUIDED_SMOKE_CHAT_ID}" \
      --arg data "finops:d:${DRAFT_ID}:select_account:${ACCOUNT_ID}" \
      '{
        update_id: $update_id,
        callback_query: {
          id: $callback_id,
          from: { id: $user_id, is_bot: false, first_name: "Smoke" },
          message: { message_id: 1, chat: { id: $chat_id } },
          data: $data
        }
      }')

    CONFIRM_PAYLOAD=$(jq -cn \
      --argjson update_id "${UPDATE_ID_CONFIRM}" \
      --arg callback_id "cb-${UPDATE_ID_CONFIRM}" \
      --argjson user_id "${GUIDED_SMOKE_USER_ID}" \
      --argjson chat_id "${GUIDED_SMOKE_CHAT_ID}" \
      --arg data "finops:d:${DRAFT_ID}:confirm" \
      '{
        update_id: $update_id,
        callback_query: {
          id: $callback_id,
          from: { id: $user_id, is_bot: false, first_name: "Smoke" },
          message: { message_id: 1, chat: { id: $chat_id } },
          data: $data
        }
      }')

    send_webhook_callback "${CATEGORY_PAYLOAD}" >/tmp/guided-bookkeeping-smoke.callback-cat.out
    sleep "${GUIDED_SMOKE_WAIT_SECONDS}"
    send_webhook_callback "${ACCOUNT_PAYLOAD}" >/tmp/guided-bookkeeping-smoke.callback-acct.out
    sleep "${GUIDED_SMOKE_WAIT_SECONDS}"
    send_webhook_callback "${CONFIRM_PAYLOAD}" >/tmp/guided-bookkeeping-smoke.callback-conf.out
  fi
fi

log "4/5 等待並驗證交易數增加"
NEW_COUNT=""
for i in $(seq 1 "${GUIDED_SMOKE_ATTEMPTS}"); do
  sleep "${GUIDED_SMOKE_WAIT_SECONDS}"
  if NEW_COUNT=$(fetch_transaction_count 2>/tmp/guided-bookkeeping-smoke.trans.err); then
    if (( NEW_COUNT > BASE_COUNT )); then
      log "交易數已增加：${BASE_COUNT} -> ${NEW_COUNT}"
      break
    fi
  fi
done

if [[ -z "${NEW_COUNT}" || ${NEW_COUNT} -le ${BASE_COUNT} ]]; then
  log "未觀察到交易數增加。請檢查助手回應是否卡住。"
  log "可直接觀察 Telegram 與 webhook 回應，確認草稿是否進入 confirm。"
  exit 1
fi

if ! jq -e '.result != null' /tmp/guided-bookkeeping-smoke.transactions.json >/dev/null 2>&1; then
  if ! jq '.result = []' /tmp/guided-bookkeeping-smoke.transactions.json >/tmp/guided-bookkeeping-smoke.transactions.json; then
    :
  fi
fi

if [[ -f /tmp/guided-bookkeeping-smoke.transactions.json ]]; then
  TEST_TX_ID=$(jq -r --arg marker "${MARKER}" '(.result // []) | map(select(.note // "" | contains($marker))) | .[0].id // empty' /tmp/guided-bookkeeping-smoke.transactions.json)
fi

if [[ -z "${TEST_TX_ID}" ]]; then
  log "找不到帶 marker 的測試交易，拒絕自動刪除以免刪錯真實資料。"
  log "請手動定位 note 包含 ${MARKER} 的交易，清理後再確認交易數恢復。"
  log "  基準：${BASE_COUNT}"
  log "  目前：${NEW_COUNT}"
  exit 1
fi

log "5/5 嘗試回滾測試交易 (${TEST_TX_ID:-無法自動辨識})"
if [[ -n "${TEST_TX_ID}" ]] && delete_transaction_via_api "${TEST_TX_ID}"; then
  AFTER_COUNT="$(fetch_transaction_count)"
  if [[ "${AFTER_COUNT}" == "${BASE_COUNT}" ]]; then
    log "Smoke 測試完成，交易數已恢復：${AFTER_COUNT}"
    exit 0
  fi
  log "已嘗試刪除交易，但交易數未回到基準值。基準=${BASE_COUNT}, 目前=${AFTER_COUNT}"
  log "請手動刪除交易 ID: ${TEST_TX_ID} 後再次驗證"
  exit 1
fi

log "自動回滾失敗（可能缺少刪除 API）。"
log "請手動刪除交易 ID（若有）並確認交易數恢復："
log "  基準：${BASE_COUNT}"
log "  目前：$(fetch_transaction_count)"
exit 1
