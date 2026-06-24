#!/usr/bin/env bash

set -euo pipefail

WEALTHFOLIO_DB_PATH="${WEALTHFOLIO_DB_PATH:-/wfdata/wealthfolio.db}"
BROKER_ID="${BROKER_ID:-sinopac}"
DRY_RUN="${DRY_RUN:-false}"

if [[ ! -f "${WEALTHFOLIO_DB_PATH}" ]]; then
  echo "Wealthfolio DB not found: ${WEALTHFOLIO_DB_PATH}" >&2
  exit 1
fi

COUNT_SQL="SELECT COUNT(1)
FROM quotes
WHERE source = 'FINOPS_MARKET'
  AND asset_id IN (
    SELECT id
    FROM assets
    WHERE json_extract(metadata, '$.brokerId') = '${BROKER_ID}'
  );"

TO_DELETE=$(sqlite3 "${WEALTHFOLIO_DB_PATH}" "${COUNT_SQL}")

echo "Broker ${BROKER_ID} FINOPS_MARKET quotes to delete: ${TO_DELETE}"

if [[ "${DRY_RUN}" == "true" ]]; then
  exit 0
fi

DELETE_SQL="DELETE FROM quotes
WHERE source = 'FINOPS_MARKET'
  AND asset_id IN (
    SELECT id
    FROM assets
    WHERE json_extract(metadata, '$.brokerId') = '${BROKER_ID}'
  );"

sqlite3 "${WEALTHFOLIO_DB_PATH}" "${DELETE_SQL}"

echo "Deleted ${TO_DELETE} FINOPS_MARKET quote row(s)."