#!/usr/bin/env python3
"""Generate lightweight market context for the FinOps daily report."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable
from zoneinfo import ZoneInfo


TWSE_DAILY_URL = "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL"
TPEX_DAILY_URL = "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes"
YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?range=5d&interval=1d"

Fetcher = Callable[[str], Any]


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as file:
        return json.load(file)


def fetch_json(url: str, timeout: int = 15) -> Any:
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/json",
            "User-Agent": "homelab-finops-market-research/0.1",
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def as_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(str(value).replace(",", "").replace("--", "").strip())
    except ValueError:
        return None


def pct_change(previous: float | None, current: float | None) -> float | None:
    if previous in (None, 0) or current is None:
        return None
    return (current - previous) / previous * 100


def get_fixture_price(fixtures: dict[str, Any], provider_symbol: str) -> dict[str, Any] | None:
    value = fixtures.get(provider_symbol)
    return value if isinstance(value, dict) else None


def lookup_twse(symbol: dict[str, Any], fixtures: dict[str, Any], fetcher: Fetcher = fetch_json) -> dict[str, Any]:
    provider_symbol = symbol["providerSymbol"]
    fixture = get_fixture_price(fixtures, provider_symbol)
    if fixture:
        return normalize_price(symbol, fixture, "fixture")

    rows = fetcher(TWSE_DAILY_URL)
    for row in rows:
        if row.get("Code") == provider_symbol:
            current = as_float(row.get("ClosingPrice"))
            previous = as_float(row.get("OpeningPrice"))
            return {
                "ticker": symbol["ticker"],
                "market": symbol["market"],
                "displayName": symbol["displayName"],
                "currency": symbol["currency"],
                "source": "twse-openapi",
                "currentPrice": current,
                "previousReferencePrice": previous,
                "changePercent": pct_change(previous, current),
                "stale": False,
                "notes": ["TWSE official end-of-day data"],
            }

    return unavailable(symbol, "twse symbol not found")


def lookup_tpex(symbol: dict[str, Any], fixtures: dict[str, Any], fetcher: Fetcher = fetch_json) -> dict[str, Any]:
    provider_symbol = symbol["providerSymbol"]
    fixture = get_fixture_price(fixtures, provider_symbol)
    if fixture:
        return normalize_price(symbol, fixture, "fixture")

    rows = fetcher(TPEX_DAILY_URL)
    for row in rows:
        if row.get("SecuritiesCompanyCode") == provider_symbol or row.get("Code") == provider_symbol:
            current = as_float(row.get("Close") or row.get("LatestPrice"))
            previous = as_float(row.get("Open") or row.get("PreviousClose"))
            return {
                "ticker": symbol["ticker"],
                "market": symbol["market"],
                "displayName": symbol["displayName"],
                "currency": symbol["currency"],
                "source": "tpex-openapi",
                "currentPrice": current,
                "previousReferencePrice": previous,
                "changePercent": pct_change(previous, current),
                "stale": False,
                "notes": ["TPEx official market data"],
            }

    return unavailable(symbol, "tpex symbol not found")


def lookup_yahoo(symbol: dict[str, Any], fixtures: dict[str, Any], fetcher: Fetcher = fetch_json) -> dict[str, Any]:
    provider_symbol = symbol["providerSymbol"]
    fixture = get_fixture_price(fixtures, provider_symbol)
    if fixture:
        return normalize_price(symbol, fixture, "fixture")

    payload = fetcher(YAHOO_CHART_URL.format(symbol=provider_symbol))
    result = payload.get("chart", {}).get("result", [{}])[0]
    closes = [value for value in result.get("indicators", {}).get("quote", [{}])[0].get("close", []) if value is not None]
    if not closes:
        return unavailable(symbol, "yfinance-compatible provider returned no close prices")

    current = as_float(closes[-1])
    previous = as_float(closes[-2] if len(closes) > 1 else None)
    return {
        "ticker": symbol["ticker"],
        "market": symbol["market"],
        "displayName": symbol["displayName"],
        "currency": symbol["currency"],
        "source": "yfinance-compatible",
        "currentPrice": current,
        "previousReferencePrice": previous,
        "changePercent": pct_change(previous, current),
        "stale": False,
        "notes": ["OpenBB/yfinance-compatible daily chart input"],
    }


def normalize_price(symbol: dict[str, Any], fixture: dict[str, Any], source: str) -> dict[str, Any]:
    current = as_float(fixture.get("currentPrice"))
    previous = as_float(fixture.get("previousReferencePrice"))
    return {
        "ticker": symbol["ticker"],
        "market": symbol["market"],
        "displayName": symbol["displayName"],
        "currency": symbol["currency"],
        "source": source,
        "currentPrice": current,
        "previousReferencePrice": previous,
        "changePercent": pct_change(previous, current),
        "stale": bool(fixture.get("stale", False)),
        "notes": fixture.get("notes", []),
    }


def unavailable(symbol: dict[str, Any], reason: str) -> dict[str, Any]:
    return {
        "ticker": symbol["ticker"],
        "market": symbol["market"],
        "displayName": symbol["displayName"],
        "currency": symbol["currency"],
        "source": symbol.get("dataSource", "unknown"),
        "currentPrice": None,
        "previousReferencePrice": None,
        "changePercent": None,
        "stale": True,
        "notes": [reason],
    }


def commentary(item: dict[str, Any]) -> str:
    if item["currentPrice"] is None:
        return "No trading suggestion. Source data unavailable."

    change = item["changePercent"]
    if change is None:
        signal = "price available but change context is unavailable"
    elif change >= 2:
        signal = "positive momentum; review valuation and concentration risk before adding"
    elif change <= -2:
        signal = "negative move; check whether the decline is market-wide or symbol-specific"
    else:
        signal = "range-bound move; no strong action signal from price alone"

    return f"{signal}. Research commentary only; no broker execution."


def build_report(
    watchlist_path: Path,
    output_path: Path,
    fixture_path: Path | None,
    fetcher: Fetcher = fetch_json,
) -> dict[str, Any]:
    watchlist = load_json(watchlist_path)
    fixtures = load_json(fixture_path) if fixture_path else {}
    results = []
    failures = []

    for symbol in watchlist.get("symbols", []):
        try:
            source = symbol.get("dataSource")
            if source == "twse-openapi":
                item = lookup_twse(symbol, fixtures, fetcher)
            elif source == "tpex-openapi":
                item = lookup_tpex(symbol, fixtures, fetcher)
            else:
                item = lookup_yahoo(symbol, fixtures, fetcher)
            item["commentary"] = commentary(item)
            results.append(item)
        except (OSError, urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
            failure = unavailable(symbol, f"provider unavailable: {error.__class__.__name__}")
            failure["commentary"] = commentary(failure)
            results.append(failure)
            failures.append({"ticker": symbol.get("ticker"), "error": str(error)})

    now = dt.datetime.now(ZoneInfo(watchlist.get("timezone", "Asia/Taipei")))
    has_stale_symbols = any(item.get("stale") or item.get("currentPrice") is None for item in results)
    report = {
        "generatedAt": now.isoformat(),
        "timezone": watchlist.get("timezone", "Asia/Taipei"),
        "status": "partial" if failures or has_stale_symbols else "ok",
        "riskDisclosure": watchlist.get("report", {}).get(
            "riskDisclosure",
            "Research commentary only. No broker execution and no guaranteed outcome.",
        ),
        "symbols": results,
        "failures": failures,
    }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return report


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--watchlist", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--offline-fixture", type=Path)
    args = parser.parse_args()

    report = build_report(args.watchlist, args.output, args.offline_fixture)
    print(json.dumps({"status": report["status"], "output": str(args.output)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
