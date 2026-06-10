## Why

Firstrade currently enters the portfolio sync pipeline through CSV/export import because no confirmed Firstrade direct read-only API is available. Plaid Investments is a plausible owner-authorized live connector candidate, but it must be evaluated and implemented separately so the existing broker-sync plan can continue relying on safe CSV/manual paths.

## What Changes

- Add a dedicated Firstrade Plaid Investments live-connector investigation and implementation path.
- Confirm Firstrade institution coverage through Plaid before any production connector is enabled.
- Add an owner authorization flow using Plaid Link rather than storing Firstrade passwords, OTPs, browser sessions, or web/mobile app credentials.
- Normalize Plaid Investments accounts, holdings, securities, balances, transactions, prices, cost basis, and source freshness into the existing `SnapshotEnvelope`.
- Add refresh, webhook, rate-limit, depermission, billing, and data-retention controls before scheduled sync is allowed.
- Keep the existing Firstrade CSV/export importer as fallback when Plaid coverage, terms, pricing, or field coverage is insufficient.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `investment-portfolio-sync`: Adds a Firstrade Plaid Investments live-connector path that can produce normalized read-only portfolio snapshots after owner authorization, coverage validation, and production gates.

## Impact

- Affects FinOps assistant portfolio sync connectors, broker adapter registry, normalized portfolio store, import/live-sync endpoints, Helm secrets/jobs, operations runbooks, and user validation gates.
- May add Plaid SDK/API dependencies and new secrets for Plaid client credentials and item/access tokens.
- Requires strict handling for Plaid billing, rate limits, webhooks, item login required states, user depermission, and deletion of connector tokens.
- Does not enable broker trade execution, cash movement, Firstrade credential storage, or Firstrade web/app scraping.
