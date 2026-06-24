## Why

The SinoPac total unrealized P/L shown in Wealthfolio is materially lower than the live figure shown in the SinoPac app, and never reflects the current trading session. Verified in the running deployment: Wealthfolio values SinoPac holdings from `FINOPS_MARKET` quotes sourced from TWSE/TPEx **end-of-day OpenAPI** (`STOCK_DAY_ALL`), which during trading hours only returns the **previous trading day's close** and is stamped with today's date. The displayed P/L therefore lags real-time and cannot match the broker. SinoPac's broker snapshot already carries a live `last_price`/`pnl`, so the fix is to value from the broker's intraday price instead of stale official EOD data.

## What Changes

- Value SinoPac holdings in Wealthfolio from the broker-provided intraday `last_price` (FinOps broker snapshot) instead of TWSE/TPEx end-of-day official market prices.
- Refresh the SinoPac broker snapshot on an intraday schedule during Taiwan trading hours (09:00–13:30 TPE) every 15–30 minutes so Wealthfolio reflects the current session's P/L.
- **BREAKING (operational):** Disable the end-of-day market price sync (`FINOPS_MARKET`) for SinoPac. It only ever served SinoPac TWSE/TPEx holdings and is the source of the stale valuation. After this change, no `FINOPS_MARKET` quote overrides the broker quote for SinoPac.
- After trading hours / on non-trading days, the last intraday broker valuation persists (the broker snapshot after close already carries the day's close).
- Firstrade US holdings are unaffected — they are valued from their own statement-import snapshot, not from the SinoPac market price sync.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `investment-portfolio-sync`: clarify and change SinoPac valuation source — Wealthfolio display P/L for SinoPac SHALL come from intraday broker `last_price` refreshed during trading hours, and the end-of-day official-market price enrichment for SinoPac is removed. This also brings the previously undocumented market-price-enrichment behavior into the spec.

## Impact

- Affected code:
  - `apps/finops-assistant/scripts/wealthfolio_snapshot_sync.js` — broker snapshot → Wealthfolio quote path (FINOPS_BROKER becomes the authoritative SinoPac valuation)
  - `apps/finops-assistant/scripts/wealthfolio_market_price_sync.js` — EOD market price sync disabled for SinoPac
  - `apps/finops-assistant/scripts/sinopac_shioaji_snapshot.py` — unchanged behavior, reused on an intraday cadence
- Affected deployment/config:
  - `charts/finops-workspace/templates/portfolio-sync-cronjobs.yaml` — add/adjust an intraday SinoPac snapshot schedule; disable the EOD market price sync job
  - `charts/finops-workspace` values — schedule and broker-list configuration
  - Argo CD `finops-workspace` Application on VPS k3s (owner-gated deploy)
- Affected systems:
  - Wealthfolio SQLite `quotes` table (quote source/selection for SinoPac assets)
  - SinoPac Shioaji API (login frequency under intraday cadence; within rate/connection limits)
- Non-impact:
  - No change to Firstrade US valuation, cost-basis storage, cash balances, or research reports.
  - No new broker connector or market-universe ingestion.