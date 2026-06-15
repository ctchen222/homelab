#!/usr/bin/env bash

set -euo pipefail

POD_SELECTOR="${GUIDED_FLOW_POD_SELECTOR:-app.kubernetes.io/component=assistant}"
NAMESPACE="${GUIDED_FLOW_NAMESPACE:-finops}"
CONTEXT="${KUBECTL_CONTEXT:-furfriend-vps}"
CONTAINER="${GUIDED_FLOW_CONTAINER:-assistant}"
SINCE_MINUTES="${GUIDED_FLOW_LOG_SINCE_MINUTES:-30}"
LOG_LINES="${GUIDED_FLOW_LOG_LINES:-2000}"

if ! command -v kubectl >/dev/null 2>&1; then
  echo "kubectl is required."
  exit 1
fi
if ! command -v grep >/dev/null 2>&1; then
  echo "grep is required."
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is recommended. Continue without jq? using default patterns only."
fi

temp_logs=$(mktemp)
cleanup() {
  rm -f "$temp_logs"
}
trap cleanup EXIT

log() {
  printf '[%s] %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$*"
}

pod_name=""
if ! pod_name=$(kubectl --context "${CONTEXT}" -n "${NAMESPACE}" get pod -l "${POD_SELECTOR}" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null); then
  echo "Unable to get assistant pod with selector=${POD_SELECTOR} in ${NAMESPACE}."
  exit 1
fi

if [[ -z "${pod_name}" ]]; then
  echo "No assistant pod found in ${NAMESPACE} with selector ${POD_SELECTOR}."
  exit 1
fi

log "Collecting logs from ${pod_name} (last ${SINCE_MINUTES}m, last ${LOG_LINES} lines)."

if kubectl --context "${CONTEXT}" -n "${NAMESPACE}" logs "${pod_name}" -c "${CONTAINER}" --since="${SINCE_MINUTES}m" --tail="${LOG_LINES}" >"${temp_logs}" 2>&1; then
  :
else
  if kubectl --context "${CONTEXT}" -n "${NAMESPACE}" logs "${pod_name}" --since="${SINCE_MINUTES}m" --tail="${LOG_LINES}" >"${temp_logs}" 2>&1; then
    :
  else
    echo "Failed to collect pod logs."
    exit 1
  fi
fi

bad=0

check_pattern() {
  local name="$1"
  local pattern="$2"
  local matches
  if matches=$(grep -En "${pattern}" "${temp_logs}" || true); then
    if [[ -n "${matches}" ]]; then
      bad=1
      echo "\n[$name] suspicious matches:"
      echo "${matches}"
    else
      echo "[PASS] $name"
    fi
  else
    echo "[PASS] $name"
  fi
}

check_pattern "callback_payload_secret" 'callback_data"\s*:\s*"[^"]{60,}"'
check_pattern "raw_ebk_token" 'EBK.*(API|TOKEN|token)|Authorization:\s*Bearer'
check_pattern "raw_telegram_token" 'telegram[^\"\"]{0,40}(token|secret)|BOT_TOKEN|SECRET_TOKEN'
check_pattern "account_balance\_exposure" 'balance"\s*:\s*|"balance"|餘額|結餘|cash\s+balance'
check_pattern "raw_finance_payload" 'raw\s*(?:json|payload|request|finance)|request\s+body|requestPayload|financePayload|raw.*payload'

if [[ ${bad} -ne 0 ]]; then
  log "Guided bookkeeping no-leak check failed. Please review lines above before treating production logs as safe."
  exit 1
fi

log "Guided bookkeeping no-leak log scan passed."
