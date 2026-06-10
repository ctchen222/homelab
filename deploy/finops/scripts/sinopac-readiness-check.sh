#!/usr/bin/env bash

set -euo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-deploy/finops/docker-compose.yaml}"
ASSISTANT_SERVICE="${ASSISTANT_SERVICE:-finops-assistant}"
OUTPUT_PATH="${OUTPUT_PATH:-/tmp/sinopac-live-sync-readiness.json}"

echo "== SinoPac env and CA =="
docker compose -f "${COMPOSE_FILE}" exec -T "${ASSISTANT_SERVICE}" python3 -c '
import json
import os
import pathlib

keys = [
    "SINOPAC_API_KEY",
    "SINOPAC_SECRET_KEY",
    "SINOPAC_CA_PATH",
    "SINOPAC_CA_PASSWORD",
    "SINOPAC_PERSON_ID",
    "SINOPAC_SHIOAJI_COMMAND",
]
out = {}
for key in keys:
    value = os.environ.get(key, "")
    out[key] = {"present": bool(value), "length": len(value)}

ca_path = os.environ.get("SINOPAC_CA_PATH", "")
ca_file = pathlib.Path(ca_path) if ca_path else None
out["ca_file"] = {
    "path_present": bool(ca_path),
    "exists": ca_file.exists() if ca_file else False,
    "size": ca_file.stat().st_size if ca_file and ca_file.exists() else 0,
}
print(json.dumps(out, ensure_ascii=False, indent=2))
'

echo
echo "== Shioaji account signed status =="
docker compose -f "${COMPOSE_FILE}" exec -T "${ASSISTANT_SERVICE}" python3 -c '
import json
import os
import sys
import shioaji as sj

api = sj.Shioaji(simulation=False)
api.login(api_key=os.environ["SINOPAC_API_KEY"], secret_key=os.environ["SINOPAC_SECRET_KEY"], fetch_contract=False)

accounts = []
for account in api.list_accounts():
    account_type = getattr(account, "account_type", None)
    accounts.append({
        "account_type": str(getattr(account_type, "value", account_type)),
        "signed": bool(getattr(account, "signed", False)),
        "has_person_id": bool(getattr(account, "person_id", None)),
        "broker_id_suffix": str(getattr(account, "broker_id", ""))[-2:],
        "account_id_len": len(str(getattr(account, "account_id", ""))),
    })

stock_account = next((account for account in accounts if account["account_type"] == "S"), None)
print(json.dumps({
    "has_stock_account": stock_account is not None,
    "stock_account_signed": stock_account["signed"] if stock_account else None,
    "accounts": accounts,
}, ensure_ascii=False, indent=2))
sys.stdout.flush()
os._exit(0)
'

echo
echo "== SinoPac live sync summary =="
docker compose -f "${COMPOSE_FILE}" --profile jobs run --rm portfolio-sync-sinopac-live > "${OUTPUT_PATH}"
jq '{
  ok,
  brokerId: .snapshot.brokerId,
  accountAlias: .snapshot.account.accountAlias,
  sourceName: .snapshot.sourceFreshness.sourceName,
  freshness: .snapshot.sourceFreshness.status,
  missingFields: .snapshot.sourceFreshness.missingFields,
  holdingsCount: (.snapshot.holdings | length),
  cashCount: (.snapshot.cashBalances | length),
  errors: [.snapshot.errors[] | {errorClass, message: (.message | sub("request #[^ ]+"; "request #[redacted]")?)}]
}' "${OUTPUT_PATH}"
