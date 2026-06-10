#!/usr/bin/env bash

set -euo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-deploy/finops/docker-compose.yaml}"
ASSISTANT_SERVICE="${ASSISTANT_SERVICE:-finops-assistant}"
SIMULATION_SYMBOL="${SINOPAC_SIMULATION_SYMBOL:-2890}"
SIMULATION_PRICE="${SINOPAC_SIMULATION_PRICE:-28}"

docker compose -f "${COMPOSE_FILE}" exec -T "${ASSISTANT_SERVICE}" python3 -c '
import json
import os
import sys
import shioaji as sj

symbol = os.environ.get("SINOPAC_SIMULATION_SYMBOL", "'"${SIMULATION_SYMBOL}"'")
price = float(os.environ.get("SINOPAC_SIMULATION_PRICE", "'"${SIMULATION_PRICE}"'"))
os.environ["SJ_LOG_PATH"] = "/tmp/shioaji.log"

api = sj.Shioaji(simulation=True)
result = {"simulation": True, "symbol": symbol}

accounts = api.login(
    api_key=os.environ["SINOPAC_API_KEY"],
    secret_key=os.environ["SINOPAC_SECRET_KEY"],
    fetch_contract=True,
)
result["login_ok"] = True
result["accounts_count"] = len(accounts) if accounts else 0
result["has_stock_account"] = api.stock_account is not None

contract = api.Contracts.Stocks.get(symbol)
if contract is None and symbol == "2890":
    contract = api.Contracts.Stocks.get("0050")
    symbol = "0050"
    price = 100.0
if contract is None:
    raise RuntimeError(f"simulation contract not found: {symbol}")

order = sj.StockOrder(
    action=sj.Action.Buy,
    price=price,
    quantity=1,
    price_type=sj.StockPriceType.LMT,
    order_type=sj.OrderType.ROD,
    order_lot=sj.StockOrderLot.Common,
    order_cond=sj.StockOrderCond.Cash,
    account=api.stock_account,
)
trade = api.place_order(contract, order)
status_obj = getattr(trade, "status", None)
status = getattr(status_obj, "status", status_obj)

result["contract_code"] = getattr(contract, "code", None)
result["contract_exchange"] = str(getattr(contract, "exchange", None))
result["place_order_ok"] = True
result["trade_status"] = str(status)
result["trade_status_code"] = str(getattr(status_obj, "status_code", ""))
result["trade_message"] = str(getattr(status_obj, "msg", ""))[:300]
result["test_report_likely_accepted"] = result["trade_status"] in [
    "OrderStatus.PendingSubmit",
    "OrderStatus.Submitted",
    "PendingSubmit",
    "Submitted",
]

print(json.dumps(result, ensure_ascii=False, indent=2))
sys.stdout.flush()
os._exit(0)
'
