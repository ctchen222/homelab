## Context

`add-investment-intelligence-broker-sync` already defines the durable portfolio sync boundary: broker adapters emit normalized `SnapshotEnvelope` records, and Wealthfolio is a display target rather than the source of truth. Firstrade currently remains CSV/export import-first because no confirmed Firstrade direct read-only account API is available.

Plaid Investments can read user-authorized investment accounts through Plaid Link, holdings, transactions, securities, and refresh/webhook APIs. It is a plausible Firstrade live connector only if Plaid confirms Firstrade coverage for the owner's account and the owner accepts Plaid's production, pricing, retention, and depermission requirements.

## Goals / Non-Goals

**Goals:**

- Confirm whether the owner can connect Firstrade through Plaid Investments.
- Add a read-only Plaid Investments connector that maps accounts, holdings, balances, securities, cost basis, prices, values, transactions, and source freshness to `SnapshotEnvelope`.
- Keep Plaid credentials, access tokens, item IDs, webhooks, and billing state in secrets/private storage.
- Preserve Firstrade CSV/export import as fallback.
- Add operations for refresh, item login required states, webhook updates, rate limits, owner depermission, token deletion, and billing controls.

**Non-Goals:**

- Do not implement Firstrade direct API access unless Firstrade publishes or approves it.
- Do not use Apex APIs unless Apex/Firstrade explicitly provides an owner-approved retail read-only access path.
- Do not store Firstrade passwords, OTPs, browser cookies, or web/mobile sessions.
- Do not place trades, modify orders, move cash, or mutate Firstrade accounts.
- Do not infer current holdings from transaction history when Plaid holdings are unavailable.

## Decisions

### Decision 1: Gate production on Firstrade coverage and owner authorization

The connector must not be considered production-ready until Firstrade is confirmed in Plaid coverage for the owner's account and the owner completes Plaid Link authorization with Investments consent.

Rationale: Plaid product availability is institution/account dependent. A generic Plaid Investments API does not prove Firstrade coverage for this owner.

### Decision 2: Store Plaid connector state separately from normalized snapshots

Plaid `item_id`, `access_token`, webhook state, error state, refresh timestamps, and billing-related metadata should live in private connector storage or secrets. `SnapshotEnvelope` should contain normalized portfolio data and non-sensitive source metadata only.

Rationale: Downstream consumers do not need Plaid tokens, and token lifecycle differs from snapshot retention.

### Decision 3: Use holdings as the source of current positions

The live connector should treat Plaid holdings/balances as current portfolio state. Plaid transactions may enrich activity history, but transactions alone must not be used to mark current holdings verified.

Rationale: Reconstructing positions from transactions is error-prone, especially with corporate actions, transfers, options, fees, and missing history.

### Decision 4: Keep CSV fallback active

If Plaid coverage, pricing, refresh, field coverage, or terms are unacceptable, the existing Firstrade CSV/import workflow remains the supported path.

Rationale: CSV import is owner-controlled, avoids aggregator billing, and keeps the current plan unblocked.

## Risks / Trade-offs

- [Risk] Plaid may not support Firstrade Investments for this owner account. -> Mitigation: keep the connector candidate-gated and use CSV fallback.
- [Risk] Plaid pricing or production approval may be unsuitable for a personal homelab. -> Mitigation: require explicit billing approval before production Items or scheduled refresh.
- [Risk] Plaid fields can be nullable or institution-dependent. -> Mitigation: mark snapshots partial when cost basis, price, value, or cash fields are missing.
- [Risk] Plaid Items can enter `ITEM_LOGIN_REQUIRED`, MFA, or rate-limited states. -> Mitigation: classify errors, preserve last known good snapshots with freshness metadata, and avoid tight retry loops.
- [Risk] Tokens and item IDs are sensitive. -> Mitigation: store them in private secrets/storage, redact logs, and support depermission/token deletion.

## Migration Plan

1. Create a Plaid sandbox/development integration and verify Investments product behavior without real Firstrade data.
2. Use Plaid institution coverage tooling or Link to verify Firstrade availability for the owner.
3. Add private connector state storage and secret references.
4. Implement Plaid Link token creation and Item exchange through a private owner-only path.
5. Implement holdings/balances sync to normalized snapshots.
6. Implement refresh/webhook/error handling and redaction.
7. Run fixture/sandbox tests, then owner-approved real-data preview.
8. Enable scheduled sync only after coverage, billing, owner authorization, field coverage, and Wealthfolio display are approved.

Rollback:

- Disable Plaid scheduled jobs first.
- Preserve normalized snapshots unless the owner requests purge.
- Delete or deauthorize Plaid Items/tokens when disabling the connector permanently.
- Fall back to Firstrade CSV/import.

## Open Questions

- Does Plaid support Firstrade Investments for the owner's account and region?
- Is Plaid pricing acceptable for this personal homelab use case?
- Which fields are populated for the owner's Firstrade holdings: cost basis, market value, price, currency, cash, transactions?
- Should Plaid sync be scheduled daily, on webhook, or manual only?
- Where should owner-only Plaid Link authorization be exposed inside the private FinOps surface?
