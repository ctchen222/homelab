#!/usr/bin/env bash

set -euo pipefail

: "${ASSISTANT_INTERNAL_TOKEN:?ASSISTANT_INTERNAL_TOKEN is required}"

BASE_URL="${BASE_URL:-http://localhost:8090}"
TARGET="${PORTFOLIO_EXPORT_TARGET:-wealthfolio-local}"
FORMAT="${PORTFOLIO_EXPORT_FORMAT:-json}"
INCLUDE_PARTIAL_OR_STALE="${PORTFOLIO_EXPORT_INCLUDE_PARTIAL_OR_STALE:-false}"

curl -fsS -X POST \
  -H "Content-Type: application/json" \
  -H "X-Internal-Token: ${ASSISTANT_INTERNAL_TOKEN}" \
  -d "{\"target\":\"${TARGET}\",\"format\":\"${FORMAT}\",\"includePartialOrStale\":${INCLUDE_PARTIAL_OR_STALE}}" \
  "${BASE_URL}/internal/portfolio/wealthfolio/export"
