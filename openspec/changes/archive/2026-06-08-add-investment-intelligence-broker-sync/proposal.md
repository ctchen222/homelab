## Why

The FinOps MVP deploys Wealthfolio and basic finance/reporting surfaces, but it does not provide a trusted, broker-portable source of the user's real investment portfolio. Investment research reports should not be built until broker holdings, cash balances, source freshness, and display boundaries are reliable.

This change is now scoped to the portfolio data foundation after `add-lightweight-finops-app`: read-only broker sync/import, normalized portfolio snapshots, and Wealthfolio display integration. Market-wide research, news/theme ingestion, signal generation, LLM summarization, and Telegram investment recommendations move to `add-investment-research-reports`.

## What Changes

- Add read-only broker synchronization/import for the user's SinoPac Taiwan stock account and Firstrade US account.
- Add provider-neutral broker adapter contracts so SinoPac, Firstrade, generic CSV, Plaid/Apex candidates, and future brokers can feed the same normalized snapshot model.
- Store normalized portfolio snapshots for holdings, cash, cost basis, market value, unrealized P/L, account currency, source type, and source freshness.
- Treat SinoPac/Shioaji as the first Taiwan read-only API connector where account permissions support it, with SinoPac CSV as fallback.
- Treat Firstrade as connector-candidate plus CSV/export fallback: investigate Plaid Investments/Apex/Firstrade read-only paths, and use owner-provided exports when no approved live connector is available.
- Add CSV/import validation, preview, owner approval, idempotency, and raw-file retention controls.
- Add Wealthfolio display integration from normalized snapshots without making Wealthfolio the recommendation source of truth.
- Keep all broker integration read-only and explicitly forbid order placement, order modification, cash movement, account mutation, or automated trade execution.

## Out of Scope

- Taiwan/US market-universe ingestion.
- News, filing, RSS, or market-narrative ingestion.
- Signal generation and recommendation policy.
- LLM-generated investment research reports.
- Telegram investment recommendation delivery.
- Automated broker execution or any account mutation.

Those are owned by `add-investment-research-reports`, which consumes the normalized portfolio snapshots produced by this change.

## Capabilities

### New Capabilities

- `investment-portfolio-sync`: Follow-on portfolio foundation after the FinOps MVP, covering read-only broker sync/import, broker-portable normalized portfolio snapshots, source freshness, sensitive data handling, and Wealthfolio display integration.

### Modified Capabilities

- None. The existing `finops-app` MVP remains responsible for Wealthfolio deployment and basic FinOps assistant/reporting surfaces. This change only adds the investment portfolio data pipeline that Wealthfolio and later research reports can consume.

## Impact

- Adds a new OpenSpec capability under `investment-portfolio-sync`.
- Future implementation may add broker connector jobs, import jobs, portfolio snapshot storage, Wealthfolio export/sync adapters, secrets/configuration, and operational runbooks.
- Requires secret handling for SinoPac/Shioaji credentials and any approved live Firstrade/Plaid/Apex connector credentials.
- Requires a clear Firstrade data strategy because official public Firstrade documentation emphasizes web/mobile account management and CSV exports rather than a confirmed stable public read-only account API.
- Requires a broker adapter boundary so later broker moves only require a new connector/importer and do not change Wealthfolio display or downstream research report contracts.
- Requires private storage, retention, redaction, and owner approval controls for account-specific holdings, cash balances, and raw broker exports.
