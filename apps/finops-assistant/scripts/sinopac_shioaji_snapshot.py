#!/usr/bin/env python3
import json
import os
import sys
from decimal import Decimal


def env(name):
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"missing {name}")
    return value


def decimal_text(value):
    if value is None:
        return None
    try:
        return format(Decimal(str(value)), "f")
    except Exception:
        return str(value)


def read_attr(obj, *names):
    for name in names:
        if isinstance(obj, dict) and name in obj:
            return obj[name]
        if hasattr(obj, name):
            return getattr(obj, name)
    return None


def contract_for(contracts, code):
    stocks = getattr(contracts, "Stocks", None)
    if stocks is None:
        return None

    for bucket_name in ("TSE", "OTC"):
        try:
            bucket = getattr(stocks, bucket_name)
            contract = bucket[code]
            if contract:
                return contract
        except Exception:
            pass

    try:
        return stocks[code]
    except Exception:
        return None


def market_from_contract(contract):
    exchange = read_attr(contract, "exchange")
    exchange_value = str(read_attr(exchange, "value") or exchange or "")
    if exchange_value == "OTC":
        return "TPEx"
    if exchange_value == "TSE":
        return "TWSE"
    return None


def normalize_position(position, requested_at, contracts=None):
    code = read_attr(position, "code", "symbol", "stock_id")
    quantity = read_attr(position, "quantity", "qty", "share")
    if code is None or quantity is None:
        raise RuntimeError(f"unsupported Shioaji position payload: {position!r}")

    code = str(code)
    contract = contract_for(contracts, code) if contracts is not None else None
    average_cost = read_attr(position, "price", "avg_price", "average_cost", "averageCost")
    cost_basis = None
    if average_cost is not None:
        try:
            cost_basis = Decimal(str(average_cost)) * Decimal(str(quantity))
        except Exception:
            cost_basis = None

    return {
        "market": read_attr(position, "market") or market_from_contract(contract) or "TWSE",
        "code": code,
        "name": read_attr(position, "name", "security_name") or read_attr(contract, "name"),
        "currency": "TWD",
        "quantity": decimal_text(quantity),
        "averageCost": decimal_text(average_cost),
        "costBasis": decimal_text(cost_basis),
        "lastPrice": decimal_text(read_attr(position, "last_price", "price", "close")),
        "marketValue": decimal_text(read_attr(position, "market_value", "value")),
        "unrealizedPnl": decimal_text(read_attr(position, "pnl", "unrealized_pnl")),
        "unrealizedPnlPercent": decimal_text(read_attr(position, "yd_percent", "pnl_percent")),
        "asOf": requested_at,
    }


def normalize_cash(balance, requested_at):
    amount = read_attr(balance, "acc_balance", "balance", "amount", "available_balance")
    if amount is None:
        return None
    return {
        "currency": "TWD",
        "amount": decimal_text(amount),
        "balanceType": "available",
        "asOf": requested_at,
    }


def account_type(account):
    raw = read_attr(account, "account_type")
    return str(read_attr(raw, "value") or raw)


def stock_account_from(api):
    accounts = getattr(api, "list_accounts", lambda: [])()
    stock = next((account for account in accounts if account_type(account) == "S"), None)
    return stock or getattr(api, "stock_account", None)


def main():
    try:
        import shioaji as sj

        requested_at = os.environ.get("SINOPAC_REQUESTED_AT", "").strip() or None
        api = sj.Shioaji(simulation=False)
        api.login(api_key=env("SINOPAC_API_KEY"), secret_key=env("SINOPAC_SECRET_KEY"), fetch_contract=True)

        account = stock_account_from(api)
        if account is None:
            raise RuntimeError("no SinoPac stock account is available after Shioaji login")
        if not read_attr(account, "signed"):
            raise RuntimeError("SinoPac stock account is not signed for Shioaji API. Complete API signing and Python simulation test review before live account sync.")

        person_id = os.environ.get("SINOPAC_PERSON_ID", "").strip() or read_attr(account, "person_id")
        api.activate_ca(ca_path=env("SINOPAC_CA_PATH"), ca_passwd=env("SINOPAC_CA_PASSWORD"), person_id=person_id)

        raw_positions = api.list_positions(account, unit=sj.Unit.Share)
        positions = [normalize_position(position, requested_at, api.Contracts) for position in raw_positions]

        cash_balances = []
        if hasattr(api, "account_balance"):
            balance = api.account_balance()
            normalized = normalize_cash(balance, requested_at)
            if normalized:
                cash_balances.append(normalized)

        print(json.dumps({"positions": positions, "cashBalances": cash_balances}, ensure_ascii=True))
    except Exception as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=True), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
