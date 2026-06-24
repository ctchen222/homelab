## Context

FinOps syncs SinoPac (Shioaji) Taiwan holdings into Wealthfolio, which recomputes unrealized P/L from quotes. Verified in the running deployment:

- The SinoPac total unrealized P/L shown in Wealthfolio is materially lower than the live figure in the SinoPac app and never reflects the current session. The displayed figure reconstructs exactly from `FINOPS_MARKET` quotes per holding as `(price − avg_cost) × qty`, confirming the displayed price source.
- `FINOPS_MARKET` is sourced from TWSE `STOCK_DAY_ALL` / TPEx `tpex_mainboard_quotes` — **end-of-day OpenAPI**. During trading hours TWSE returns the *previous* trading day's close; the sync stamps it with the execution date (`wealthfolio_market_price_sync.js` `context.today = snapshotDate(now)`), so stale data is labeled as today.
- The SinoPac broker snapshot (`sinopac_shioaji_snapshot.py`) already returns Shioaji's live `last_price` and `pnl`, written as `FINOPS_BROKER` quotes by `wealthfolio_snapshot_sync.js`. When the broker snapshot is not refreshed intraday, the newer-dated `FINOPS_MARKET` quote overrides it.
- The EOD market price sync (`WEALTHFOLIO_PRICE_SYNC_BROKERS` defaults to `sinopac`) serves **only** SinoPac TWSE/TPEx holdings. Firstrade US holdings are valued from their own statement-import snapshot.
- The chart already defines a chained intraday cadence (all currently disabled in base values): `sinoPacLiveSync` (`10,40 9-13 * * 1-5`) → `wealthfolioSnapshotSync` (`20,50 9-13 * * 1-5`) → `marketPriceSync` (`25,55 9-13 * * 1-5`). The live broker chain already exists; the staleness comes from `marketPriceSync` writing `FINOPS_MARKET` on top of it. The change is therefore primarily configuration, not new pipeline code.

Deployment reality (from prior rollout): the chart `charts/finops-workspace` auto-renders from `main` via Argo CD, but stage/value changes to the Application CR are owner-gated. CronJobs already exist for portfolio sync, daily report, EOD spending, and market research.

## Goals / Non-Goals

**Goals:**
- Wealthfolio's SinoPac unrealized P/L tracks the live broker value during the trading session (within the chosen refresh cadence).
- Remove the stale EOD price source as the SinoPac valuation input.
- Keep the change minimal by reusing the existing broker snapshot pipeline.

**Non-Goals:**
- Sub-minute / tick-level real-time valuation.
- Changing Firstrade US valuation, cost-basis logic, cash balances, or research reports.
- Adding a new broker connector or a dedicated `api.snapshots()` price path (evaluated but not chosen).
- Guaranteeing exact penny-parity with the SinoPac app at every instant (cadence and Shioaji snapshot timing introduce small differences).

## Decisions

### Decision 1: Reuse the existing broker snapshot chain (the "shortcut") instead of a dedicated `api.snapshots()` price path
`sinoPacLiveSync` → `wealthfolioSnapshotSync` (`sinopac_shioaji_snapshot.py` + `wealthfolio_snapshot_sync.js`) already produce `FINOPS_BROKER` quotes from Shioaji live `last_price` on a chained intraday schedule. Enabling this existing chain (and disabling the EOD job) yields live valuation with essentially no new code.

- **Alternative considered:** a new lightweight `api.snapshots()` quote-only path. Leaner per run and better for high frequency, but adds new Python+JS code. Rejected for now because the chosen cadence (15–30 min) does not need it; can be revisited if cadence tightens.
- **Trade-off:** each intraday run does a full position resync (account/asset upserts, stale-asset cleanup) — heavier per run, acceptable at this cadence.

### Decision 2: Disable the EOD market price sync for SinoPac
`wealthfolio_market_price_sync.js` is the source of the stale `FINOPS_MARKET` quote and only served SinoPac. Disabling it removes the overriding stale price so the `FINOPS_BROKER` quote becomes authoritative.

- **Alternative considered:** keep EOD as an after-hours/weekend fallback. Rejected per owner decision — the intraday broker snapshot already carries the day's close after market, so EOD adds no value and reintroduces the override ambiguity.

### Decision 3: Make the broker quote the selected valuation price
Wealthfolio selects the latest quote per asset. With `FINOPS_MARKET` gone and the broker snapshot refreshed intraday (quote `day` = snapshot as-of date = today), `FINOPS_BROKER` becomes the newest quote and is selected. Intraday re-runs update the same `(asset_id, day, source)` row via the existing `ON CONFLICT ... DO UPDATE`.

- **Note:** the date-mislabel issue in the EOD sync becomes moot once EOD is disabled, but the spec records the correctness expectation (quote date should match its data's as-of) to prevent regressions.

### Decision 4: Cadence — chained intraday runs plus a post-close capture
The existing schedules run the chain every 30 min during 09:00–13:xx TPE on trading days: live snapshot at `:10/:40`, projection at `:20/:50`. Because close is 13:30 TPE, the `13:40` live snapshot captures the closing `last_price` and the `13:50` projection persists it — this is the post-close capture that locks the day's closing valuation until the next session. Shioaji limits (snapshots ≤ 50 / 5s, ≥ 500MB/day, ≤ 5 connections per person) are far from binding at this cadence. Reading quotes needs only `login()`, not `activate_ca`. The schedule's hour range MUST keep a run at or after 13:30 so the closing price is captured.

### Decision 5: One-time cleanup of existing `FINOPS_MARKET` quotes
Disabling the EOD job stops new `FINOPS_MARKET` writes, but rows already written (especially at today's date) may still be selected over `FINOPS_BROKER` on the same day. Rollout includes a one-time deletion of `FINOPS_MARKET` quotes for SinoPac assets so the broker quote becomes the selected valuation immediately.

## Risks / Trade-offs

- **Shioaji login frequency / connection limit** → cadence kept at 15–30 min; reuse a single login per run; avoid overlapping runs (cron concurrency policy = Forbid).
- **Snapshot failure mid-session leaves stale value** → rely on existing freshness metadata to mark stale; the spec requires stale marking rather than silent staleness.
- **Heavier per-run DB churn from full resync** → acceptable at this cadence; revisit Decision 1 if cadence tightens.
- **Removing EOD removes a fallback** → after-hours value comes from the last successful intraday snapshot (which holds the day's close); if the final run of the day fails, the displayed value may be one cadence-interval old until the next session.
- **Production deploy is owner-gated** → chart changes land on `main`, but enabling the new schedule / disabling EOD on the live Application CR requires the owner; tasks call this out explicitly.

## Migration Plan

1. Land script + chart changes on `main` (auto-renders via Argo CD chart sync).
2. Owner enables the intraday SinoPac snapshot schedule and disables the EOD market price sync job on the live `finops-workspace` Application.
3. Verify on VPS: during trading hours, `FINOPS_BROKER` quotes refresh and no new `FINOPS_MARKET` quotes appear for SinoPac; Wealthfolio total P/L tracks the SinoPac app within cadence.
4. Rollback: re-enable the EOD market price sync job and restore the prior snapshot schedule.