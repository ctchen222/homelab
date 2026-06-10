#!/usr/bin/env bash

set -euo pipefail

: "${ASSISTANT_INTERNAL_TOKEN:?ASSISTANT_INTERNAL_TOKEN is required}"

BASE_URL="${BASE_URL:-http://localhost:8090}"
BROKER_ID="${PORTFOLIO_FIXTURE_BROKER_ID:-fixture}"
ACCOUNT_ALIAS="${PORTFOLIO_FIXTURE_ACCOUNT_ALIAS:-fixture-main}"
ADAPTER_ID="${PORTFOLIO_FIXTURE_ADAPTER_ID:-fixture-broker}"
SCENARIO="${PORTFOLIO_FIXTURE_SCENARIO:-complete}"
REQUESTED_AT="${PORTFOLIO_FIXTURE_REQUESTED_AT:-$(date -u +"%Y-%m-%dT%H:%M:%SZ")}"

curl -fsS -X POST \
  -H "Content-Type: application/json" \
  -H "X-Internal-Token: ${ASSISTANT_INTERNAL_TOKEN}" \
  -d "{\"brokerId\":\"${BROKER_ID}\",\"accountAlias\":\"${ACCOUNT_ALIAS}\",\"adapterId\":\"${ADAPTER_ID}\",\"scenario\":\"${SCENARIO}\",\"requestedAt\":\"${REQUESTED_AT}\"}" \
  "${BASE_URL}/internal/portfolio/sync/fixture"
