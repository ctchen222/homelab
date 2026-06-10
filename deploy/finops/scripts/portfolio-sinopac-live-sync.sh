#!/usr/bin/env bash

set -euo pipefail

: "${ASSISTANT_INTERNAL_TOKEN:?ASSISTANT_INTERNAL_TOKEN is required}"

BASE_URL="${BASE_URL:-http://localhost:8090}"
ACCOUNT_ALIAS="${SINOPAC_ACCOUNT_ALIAS:-sinopac-main}"
REQUESTED_AT="${SINOPAC_REQUESTED_AT:-$(date -u +"%Y-%m-%dT%H:%M:%SZ")}"

curl -fsS -X POST \
  -H "Content-Type: application/json" \
  -H "X-Internal-Token: ${ASSISTANT_INTERNAL_TOKEN}" \
  -d "{\"brokerId\":\"sinopac\",\"accountAlias\":\"${ACCOUNT_ALIAS}\",\"requestedAt\":\"${REQUESTED_AT}\"}" \
  "${BASE_URL}/internal/portfolio/sync/live"
