## 1. Valuation source (scripts)

- [x] 1.1 Confirm `wealthfolio_snapshot_sync.js` writes `FINOPS_BROKER` quotes from SinoPac `last_price` and that intraday re-runs update the same `(asset_id, day, source)` row via `ON CONFLICT ... DO UPDATE`
- [x] 1.2 Confirm SinoPac valuation falls back to `FINOPS_BROKER` as the selected quote once no `FINOPS_MARKET` quote exists
- [x] 1.3 Add/adjust unit tests in `apps/finops-assistant/test/` covering: SinoPac quote uses broker `last_price`; quote date matches the snapshot as-of date (no execution-date mislabel)
- [x] 1.4 Remove cross-request caching from `createSinoPacShioajiBridgeProvider` so each `/internal/portfolio/sync/live` request executes the Shioaji bridge and reads current broker positions
- [x] 1.5 Add a regression test for repeated SinoPac live syncs using the same provider instance: first bridge payload returns the old holdings set, second bridge payload returns a changed holdings set, and the second persisted snapshot reflects the changed holdings
- [x] 1.6 Add a regression test that a live sync cannot produce a new `fetchedAt` run from an old cached `sourceTimestamp` without re-reading the broker bridge

## 2. Disable EOD market price source

- [x] 2.1 Set `portfolioSync.jobs.marketPriceSync.enabled: false` so no new `FINOPS_MARKET` quotes are written for SinoPac (keep `wealthfolio_market_price_sync.js` in the repo)
- [x] 2.2 One-time cleanup: delete existing `FINOPS_MARKET` quotes for SinoPac assets in the Wealthfolio DB so `FINOPS_BROKER` becomes the selected valuation immediately
- [x] 2.3 Verify Firstrade US valuation is unchanged (its snapshot path does not depend on the SinoPac market price sync)

## 3. Enable the live broker chain (Helm values)

- [x] 3.1 Enable `portfolioSync.jobs.sinoPacLiveSync` and `portfolioSync.jobs.wealthfolioSnapshotSync` on their chained intraday schedules (live snapshot runs before the Wealthfolio projection)
- [x] 3.2 Confirm the schedule keeps a run at or after market close (13:30 TPE) so the closing price is captured — the hour-13 `:40` live snapshot and `:50` projection satisfy this
- [x] 3.3 Confirm `concurrencyPolicy: Forbid` on the live-chain CronJobs (already set in template) to avoid overlapping Shioaji logins
- [x] 3.4 Render the chart locally (`helm template`) and confirm: `sinoPacLiveSync` + `wealthfolioSnapshotSync` present and enabled, `marketPriceSync` absent/disabled

## 4. Pre-merge k3d verification

- [x] 4.1 Create a disposable k3d cluster and apply the rendered `portfolio-sync-cronjobs.yaml` output for `values-prod-stage6.yaml`
- [x] 4.2 Verify the rendered/applied CronJobs include `sinopac-live-sync` and `wf-snapshot-sync` on the intended chained intraday schedules
- [x] 4.3 Verify both live-chain CronJobs use `timeZone: Asia/Taipei`, `concurrencyPolicy: Forbid`, and are not suspended
- [x] 4.4 Verify the rendered/applied CronJobs do not include an enabled SinoPac `wf-price-sync` path that would write new `FINOPS_MARKET` quote overrides
- [x] 4.5 Delete the disposable k3d cluster after verification

## 5. Post-merge rollout verification (not blocking this change)

These checks require the chart/values changes to be merged to `main` and synced by the live `finops-workspace` Argo CD Application. They are rollout evidence, not implementation tasks for archiving this OpenSpec change.

- Owner merges chart/values changes to `main` and confirms the live chain is enabled while the EOD job is disabled in the live Argo CD Application
- During trading hours, confirm `FINOPS_BROKER` quotes for SinoPac refresh on cadence and no new `FINOPS_MARKET` quotes are written for SinoPac (query Wealthfolio `quotes` table)
- Confirm Wealthfolio SinoPac total unrealized P/L tracks the SinoPac app within the refresh cadence
- Confirm the post-close run (about 13:40/13:50 TPE) captures the day's closing price and that value persists after hours with no stale EOD price replacing it
- Document rollback (re-enable EOD job, restore prior schedule) and record verification evidence
- Verify consecutive production `sinopac-live-sync` runs advance both `fetched_at` and broker `source_timestamp`/`as_of`; a new run must not reuse the same stale broker payload from an older assistant pod lifetime
- Verify the latest production Sinopac portfolio DB snapshot contains the current broker holdings count and symbols before `wf-snapshot-sync` projects them into Wealthfolio
- Verify the live `finops-workspace` CronJobs match the desired chart state after Argo sync, including absence or suspension of any SinoPac `wf-price-sync` path that would reintroduce `FINOPS_MARKET` overrides