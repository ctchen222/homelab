# Investment Portfolio Contracts

This document defines the repo-owned contracts for `add-investment-intelligence-broker-sync`. It keeps broker-specific sync/import, normalized portfolio storage, Wealthfolio display/export, and downstream research consumers aligned before connector code is added.

## Schema Conventions

- Schema version: `investment-portfolio.snapshot.v1`
- Timestamps: ISO 8601 strings with timezone, preferably UTC.
- Monetary and quantity values: decimal strings, not floats, to avoid rounding drift.
- Currency: ISO 4217 code such as `TWD` or `USD`.
- Market: canonical market code such as `TWSE`, `TPEx`, `NASDAQ`, `NYSE`, or `NYSEARCA`.
- Broker account identity: use `accountAlias` for display and `accountIdentityHash` for stable joins. Do not store or render full account numbers as normal identifiers.
- Missing broker fields stay absent or `null`; do not infer cost basis, cash, market value, or P/L.
- Sensitive raw broker payloads and raw import rows stay outside these schemas.

```text
BrokerAccount
  -> SnapshotEnvelope
       -> Holding[]
       -> CashBalance[]
       -> ActivityRow[]
       -> SourceFreshness
       -> SyncEvent[]
       -> WealthfolioDisplayExport[]
```

## BrokerAccount

Normalized account identity shared by connectors, imports, storage, Wealthfolio export, and downstream reports.

| Field | Required | Type | Notes |
| --- | --- | --- | --- |
| `brokerId` | yes | string | Stable broker key such as `sinopac`, `firstrade`, or `manual`. |
| `accountAlias` | yes | string | Owner-defined display label, for example `sinopac-main` or `firstrade-ira`. |
| `accountIdentityHash` | yes | string | Salted hash of broker/account identity for joins without full account numbers. |
| `accountType` | no | string | Broker-provided or owner-defined type such as `taxable`, `margin`, `ira`, or `tw-stock`. |
| `baseCurrency` | yes | string | Default account currency. Multi-currency cash still uses `CashBalance.currency`. |
| `marketScope` | yes | string array | Markets this account normally holds, for example `["TWSE", "TPEx"]` or `["NASDAQ", "NYSE"]`. |
| `displayName` | no | string | Optional non-sensitive name for UI/export. |
| `status` | yes | string | `active`, `disabled`, `sync-unavailable`, or `import-only`. |
| `createdAt` | yes | timestamp | Account record creation time. |
| `updatedAt` | yes | timestamp | Last account metadata update time. |

## Holding

Normalized security position at account level.

| Field | Required | Type | Notes |
| --- | --- | --- | --- |
| `brokerId` | yes | string | Same as `BrokerAccount.brokerId`. |
| `accountAlias` | yes | string | Same as `BrokerAccount.accountAlias`. |
| `market` | yes | string | Canonical market code. |
| `symbol` | yes | string | Canonical symbol used by this repo. |
| `providerSymbol` | no | string | Broker/provider symbol if it differs from `symbol`. |
| `securityName` | no | string | Display name from broker/import when available. |
| `assetType` | yes | string | `stock`, `etf`, `fund`, `cash-equivalent`, `option`, `bond`, `crypto`, or `unknown`. |
| `currency` | yes | string | Security trading/reporting currency. |
| `quantity` | yes | decimal string | Signed position quantity. |
| `averageCost` | no | decimal string | Per-unit cost basis when available. |
| `costBasis` | no | decimal string | Total cost basis when available. |
| `lastPrice` | no | decimal string | Latest broker/import price when available. |
| `marketValue` | no | decimal string | Total market value when available. |
| `unrealizedPnl` | no | decimal string | Unrealized profit/loss amount when available. |
| `unrealizedPnlPercent` | no | decimal string | Percent string, for example `12.34`. |
| `asOf` | yes | timestamp | Source timestamp for this holding row. |
| `freshnessStatus` | yes | string | `fresh`, `stale`, `partial`, `failed`, or `unavailable`. |
| `dataQuality` | yes | string array | Flags such as `missing-cost-basis`, `missing-market-value`, or `activity-only`. |

## CashBalance

Normalized cash or settled balance row.

| Field | Required | Type | Notes |
| --- | --- | --- | --- |
| `brokerId` | yes | string | Same as `BrokerAccount.brokerId`. |
| `accountAlias` | yes | string | Same as `BrokerAccount.accountAlias`. |
| `currency` | yes | string | Cash currency. |
| `amount` | yes | decimal string | Signed cash amount. |
| `balanceType` | yes | string | `settled`, `available`, `buying-power`, `margin`, `withheld`, or `unknown`. |
| `asOf` | yes | timestamp | Source timestamp for this balance row. |
| `freshnessStatus` | yes | string | `fresh`, `stale`, `partial`, `failed`, or `unavailable`. |
| `dataQuality` | yes | string array | Flags such as `cash-endpoint-unavailable` or `statement-derived`. |

## ActivityRow

Normalized transaction, statement, or gain/loss row. Activity rows can support research context but do not prove current holdings unless paired with a current-position snapshot.

| Field | Required | Type | Notes |
| --- | --- | --- | --- |
| `brokerId` | yes | string | Same as `BrokerAccount.brokerId`. |
| `accountAlias` | yes | string | Same as `BrokerAccount.accountAlias`. |
| `activityId` | yes | string | Stable importer-generated ID or broker event ID. |
| `activityType` | yes | string | `buy`, `sell`, `dividend`, `interest`, `deposit`, `withdrawal`, `fee`, `tax`, `split`, `transfer`, `gain-loss`, or `unknown`. |
| `tradeDate` | no | date | Trade date when available. |
| `settleDate` | no | date | Settlement date when available. |
| `market` | no | string | Required for security-specific activity when known. |
| `symbol` | no | string | Required for security-specific activity when known. |
| `currency` | yes | string | Amount currency. |
| `quantity` | no | decimal string | Security quantity when relevant. |
| `price` | no | decimal string | Per-unit price when relevant. |
| `amount` | no | decimal string | Gross or net amount, based on `amountType`. |
| `amountType` | no | string | `gross`, `net`, `fee`, `tax`, or `unknown`. |
| `sourceDescription` | no | string | Sanitized broker/import description. Formula-like text must be escaped before rendering. |
| `asOf` | yes | timestamp | Import or source timestamp. |
| `dataQuality` | yes | string array | Flags such as `activity-only`, `missing-symbol`, or `statement-derived`. |

## SourceFreshness

Freshness metadata for a snapshot or per-source section.

| Field | Required | Type | Notes |
| --- | --- | --- | --- |
| `sourceType` | yes | string | Source classification defined by this change, for example `live-api` or `csv-current-position-snapshot`. |
| `sourceName` | yes | string | Adapter/importer name such as `sinopac-shioaji` or `firstrade-csv`. |
| `sourceTimestamp` | no | timestamp | Timestamp reported by the broker/export. |
| `fetchedAt` | yes | timestamp | When the sync/import job read the source. |
| `committedAt` | no | timestamp | When normalized rows were committed. |
| `maxAgeMinutes` | yes | integer | Freshness threshold used by display/export and downstream consumers. |
| `status` | yes | string | `fresh`, `stale`, `partial`, `failed`, or `unavailable`. |
| `reason` | no | string | Human-readable but non-sensitive explanation. |
| `missingFields` | yes | string array | Missing fields that affect display or downstream confidence. |

## Source Types

`sourceType` is a normalized enum used by `SourceFreshness`, `SnapshotEnvelope`, import previews, Wealthfolio display metadata, and downstream research consumers.

| Source type | Canonical value | Proves current holdings | Proves current cash | Provides activity | Required handling |
| --- | --- | --- | --- | --- | --- |
| Live API | `live-api` | yes, when holdings endpoint succeeds | yes, when balance endpoint succeeds | optional | Use only approved read-only credentials. Mark partial when any endpoint is unavailable. |
| CSV current-position snapshot | `csv-current-position-snapshot` | yes | optional | no | Treat as a point-in-time holdings snapshot. Require as-of date and owner approval before commit. |
| CSV cash snapshot | `csv-cash-snapshot` | no | yes | no | Treat as a point-in-time cash snapshot. It cannot verify holdings by itself. |
| Statement import | `statement-import` | optional | optional | optional | Use only fields present in the statement. Mark partial unless the statement clearly provides current positions and cash. |
| Transaction history | `transaction-history` | no | no | yes | Store activity rows only. Do not reconstruct current holdings without a separate approved calculation change. |
| Prior-year gain/loss | `prior-year-gain-loss` | no | no | yes | Store tax/gain-loss context only. Never mark as current holdings or current cash. |
| Partial activity-only import | `partial-activity-only-import` | no | no | yes | Use when an import lacks enough fields for holdings/cash. Downstream reports may use it only as limited historical context. |
| Manual CSV | `manual-csv` | depends on declared source fields | depends on declared source fields | depends on declared source fields | Require explicit source declaration, preview, owner approval, checksum idempotency, and data-quality flags. |

Rules:

- A source type that does not prove current holdings must emit empty `holdings` or mark holdings as `partial` or `unavailable`.
- A source type that does not prove current cash must emit empty `cashBalances` or mark cash as `partial` or `unavailable`.
- Activity-only sources must not be promoted into a verified current portfolio snapshot.
- Manual CSV imports must declare which source type they represent before commit; `manual-csv` is the adapter/import path, not permission to skip source classification.

## Freshness Rules

Freshness is evaluated per source section and then summarized at `SnapshotEnvelope.sourceFreshness`. These defaults are conservative and can be made stricter by deployment values later, but consumers must not silently treat stale or partial data as current.

| Data section | Source types | Default max age | Fresh condition | Stale or partial behavior |
| --- | --- | --- | --- | --- |
| Broker holdings snapshot | `live-api`, `csv-current-position-snapshot`, current-position `statement-import`, declared current-position `manual-csv` | 1 market day, or 24 hours when market calendar is unavailable | `sourceTimestamp` or declared `asOf` exists, required holding fields are present, and the source is within max age | Wealthfolio may display with `stale` or `partial` badge. Research reports must suppress review-add/review-reduce actions that depend on current holdings. |
| Broker cash balances | `live-api`, `csv-cash-snapshot`, cash `statement-import`, declared cash `manual-csv` | 1 calendar day | Cash currency, amount, balance type, and source/as-of timestamp are present and within max age | Wealthfolio may display stale cash separately. Research reports must avoid cash-drag, rebalance, and allocation claims from stale cash. |
| Imported raw files before commit | all import source types | 0 minutes | Never fresh for display until preview is approved and normalized rows are committed | Keep as uncommitted sensitive input. Do not display in Wealthfolio or expose to research reports. |
| Statement-derived activity | `statement-import`, `transaction-history`, `prior-year-gain-loss`, `partial-activity-only-import` | Historical context only | Activity rows have source file checksum, account alias, date range, and committed preview approval | Mark as `partial` for portfolio context. Never upgrade to current holdings or current cash without a current snapshot source. |
| Wealthfolio export artifact | any committed snapshot source | Inherits source snapshot freshness, capped at 24 hours after export | Source snapshot is fresh, export succeeded, and included fields match available snapshot fields | Mark export stale when source snapshot is stale or export is older than 24 hours. Do not imply Wealthfolio is fresher than the snapshot store. |
| Downstream research consumer | committed `SnapshotEnvelope` only | Inherits source snapshot freshness | Source snapshot is fresh enough for the specific signal or report section | Downgrade or suppress personal portfolio sections when required holdings, cash, cost basis, or P/L are stale, partial, failed, or unavailable. |

Display state matrix:

| Status | Meaning | Wealthfolio or companion display | Downstream research behavior |
| --- | --- | --- | --- |
| `fresh` | Required source fields are present and within max age. | Display normally with as-of timestamp and source type. | Personal portfolio signals may use the fields that are fresh. |
| `stale` | Required fields exist but the source is older than max age. | Display values with stale badge and as-of timestamp. | Suppress actions that depend on current values; allow historical commentary only. |
| `partial` | Source succeeded but required fields are missing or endpoint/export coverage is incomplete. | Display only available fields and list missing fields. | Use only supported fields; suppress signals requiring missing fields. |
| `failed` | Sync/import attempted and failed. | Show last known good snapshot only if it is clearly labeled with its own freshness. | Do not use failed run output; degrade to no current portfolio context. |
| `unavailable` | Source is not configured, not approved, or not supported. | Show unavailable label without placeholder values. | Run general-market-only or omit personal portfolio sections. |

Freshness computation rules:

- `sourceTimestamp` wins over `fetchedAt` when the broker/export provides it; otherwise `fetchedAt` is the freshness anchor and the snapshot must carry a `missing-source-timestamp` data-quality flag.
- The snapshot-level status is the worst required-section status for the selected consumer. For Wealthfolio, holdings and cash can be labeled independently. For research, each signal declares which fields are required.
- A newer Wealthfolio export cannot make older source data fresh. Export freshness is capped by the underlying `SnapshotEnvelope`.
- Failed or unavailable current holdings must not be backfilled from transaction history, gain/loss files, or LLM inference.

## SyncEvent

Operational event emitted by a connector or importer.

| Field | Required | Type | Notes |
| --- | --- | --- | --- |
| `syncRunId` | yes | string | Unique sync/import run ID. |
| `brokerId` | yes | string | Broker key. |
| `accountAlias` | yes | string | Account alias. |
| `adapterId` | yes | string | Connector/importer ID. |
| `mode` | yes | string | `fixture`, `dry-run`, `live-read`, `csv-import`, or `manual-import`. |
| `startedAt` | yes | timestamp | Run start. |
| `finishedAt` | no | timestamp | Run end when available. |
| `status` | yes | string | `succeeded`, `partial`, `failed`, `rejected`, or `skipped`. |
| `errorClass` | no | string | `missing-credentials`, `auth-failed`, `permission-denied`, `rate-limited`, `schema-mismatch`, `stale-source`, `unsafe-input`, `write-capable-credential`, or `unknown`. |
| `rowCounts` | yes | object | Counts for accounts, holdings, cash balances, activity rows, skipped rows, and errors. |
| `artifactRefs` | yes | string array | Private artifact IDs or paths, never raw broker file contents. |

## SnapshotEnvelope

Versioned envelope committed by any connector or importer.

| Field | Required | Type | Notes |
| --- | --- | --- | --- |
| `schemaVersion` | yes | string | Must be `investment-portfolio.snapshot.v1` for this contract. |
| `syncRunId` | yes | string | Links to `SyncEvent.syncRunId`. |
| `brokerId` | yes | string | Broker key. |
| `account` | yes | BrokerAccount | Normalized account identity. |
| `sourceType` | yes | string | Source classification. |
| `sourceFreshness` | yes | SourceFreshness | Snapshot-level freshness metadata. |
| `baseCurrency` | yes | string | Account/reporting base currency. |
| `asOf` | yes | timestamp | Best available snapshot timestamp. |
| `holdings` | yes | Holding array | Empty only when source is cash-only or failed/partial. |
| `cashBalances` | yes | CashBalance array | Empty only when source lacks cash data or failed/partial. |
| `activityRows` | yes | ActivityRow array | Empty unless the source provides activity. |
| `errors` | yes | object array | Non-sensitive error summaries. |
| `dataQuality` | yes | string array | Snapshot-level quality flags. |

## Broker Adapter Contract

Every broker connector or importer must produce the same normalized `SnapshotEnvelope`. Storage, Wealthfolio export, and downstream research consumers must never branch on broker-specific payload shape.

### Adapter Families

| Adapter ID | Broker ID | Kind | Initial status | Required output |
| --- | --- | --- | --- | --- |
| `sinopac-shioaji` | `sinopac` | read-only live connector | dry-run first | `SnapshotEnvelope` with holdings and cash where Shioaji permissions allow. |
| `sinopac-csv` | `sinopac` | CSV importer | fallback | `SnapshotEnvelope` from owner-provided current positions, cash, or statement files. |
| `firstrade-live-candidate` | `firstrade` | candidate live connector | investigation only | No production output until an official or owner-approved read-only path is confirmed. |
| `firstrade-csv` | `firstrade` | CSV/export importer | fallback first | `SnapshotEnvelope` from owner-provided positions, balances, transaction history, statement, or gain/loss exports. |
| `plaid-investments-candidate` | provider-specific | candidate aggregator connector | investigation only | `SnapshotEnvelope` only after field coverage, consent, 2FA, refresh, pricing, and terms are approved. |
| `apex-candidate` | provider-specific | candidate aggregator connector | investigation only | `SnapshotEnvelope` only after the actual carrying-broker relationship and read-only scope are approved. |
| `manual-csv` | `manual` | generic importer | fallback | `SnapshotEnvelope` for future broker migration or one-off owner-provided files. |

### Firstrade Live Connector Candidate Investigation

Investigation date: 2026-06-05.

| Candidate | Evidence found | Current decision |
| --- | --- | --- |
| Plaid Investments | Plaid Investments provides holdings and investment transactions APIs for user-authorized investment accounts in the US and Canada. Plaid also documents institution coverage lookup through the coverage explorer, `/institutions/get`, and the dashboard because coverage tables are not real-time. | Keep as the first live-connector candidate. Do not implement production sync until Firstrade is confirmed to support Plaid Investments for the owner's account and required fields. |
| Apex-related aggregation | Firstrade's help center states Apex Clearing Corporation is Firstrade's clearing firm. Apex public material describes B2B API-driven account services and event APIs, but this investigation did not verify a retail-owner read-only holdings/balances API path for an existing Firstrade account. | Keep as investigation-only. Do not treat Apex clearing relationship as usable account-data access without official Apex/Firstrade/owner-approved read-only access. |
| Firstrade-approved direct API | No verified public Firstrade read-only account API was found during the initial investigation or the 2026-06-08 refresh. Firstrade account pages and help content describe account management through Firstrade's own online platform, while public API-like read access appears only through third-party aggregator candidates such as Plaid. | Treat direct API as unconfirmed. Use CSV/export fallback until Firstrade provides an approved read-only data path. |

Source references:

- Plaid Investments docs: https://plaid.com/docs/investments/
- Plaid Investments API reference: https://plaid.com/docs/api/products/investments/
- Plaid institution coverage docs: https://plaid.com/docs/institutions/
- Plaid Institutions API docs: https://plaid.com/docs/api/institutions/
- Plaid pricing and billing docs: https://plaid.com/docs/account/billing/
- Plaid rate limit errors docs: https://plaid.com/docs/errors/rate-limit-exceeded/
- Firstrade clearing firm help article: https://help.firstrade.info/en/articles/9268434-who-is-firstrade-s-clearing-firm
- Firstrade Customer Account Agreement: https://www.firstrade.com/forms/en-us/acct_agreement.pdf
- Firstrade account balances page: https://www.firstrade.com/content/en-us/accounts/balances
- Apex account overview: https://go.apexfintechsolutions.com/apex-account-overview

### Firstrade Live Connector Feasibility Matrix

No Firstrade live connector is production-feasible until every required decision below is explicitly approved. The default implementation path remains owner-provided CSV/export/statement import.

| Dimension | Plaid Investments candidate | Apex-related candidate | Firstrade-approved direct API | Required decision before live sync |
| --- | --- | --- | --- | --- |
| Consent and authorization | Plaid Items must be created through user authorization and product consent. Firstrade support must be confirmed through Plaid coverage tools, dashboard, or `/institutions/*` checks for the owner's account. | Requires an official Apex/Firstrade or owner-approved authorization path. The clearing relationship alone does not grant account-data consent. | Requires Firstrade to publish or approve a read-only account-data path for the account owner. No public path is assumed. | Store only non-secret connector metadata in repo. Keep tokens in secrets. Do not enable until owner consent, revocation, and depermission behavior are documented. |
| 2FA and MFA | Plaid Link handles institution authentication and MFA prompts when supported. Sync must classify `INVALID_MFA`, `ITEM_LOGIN_REQUIRED`, and related errors as auth or permission failures, never as partial holdings. | Unknown until official partner docs are available. Do not automate login, OTP, browser sessions, or mobile push flows. | Unknown until Firstrade-approved docs exist. Do not script website or app authentication. | Any path that asks this repo to collect broker passwords, OTPs, browser cookies, or session tokens is rejected. |
| Refresh and staleness | Plaid exposes holdings, investment transactions, refresh, and update webhooks, but institution coverage and update timing must be verified per account. Refresh output must use `SourceFreshness` and stale/partial labels. | Unknown. A B2B event API description is not enough to prove owner-account holdings refresh. | Unknown. Use only documented API/export timestamps. | Set conservative polling and stale rules before scheduled sync. Do not infer current holdings from transactions or gain/loss rows. |
| Pricing and billing | Plaid Investments uses subscription billing; Investments Refresh is per-request. Trial, pay-as-you-go, growth, or custom plan constraints must be accepted before any production Item is created. | Unknown. Treat as commercial/contract work until Apex/Firstrade confirms eligibility, costs, and billing events. | Unknown. Treat as unavailable until Firstrade provides terms and costs. | Do not create production Items or paid connector state from a scheduled job without owner approval and a billing runbook. |
| Rate limits and backoff | Plaid documents endpoint and institution-level 429 classes, including Investments holdings and transactions limits. Connector must use backoff, retry budgets, and `rate-limited` sync events. | Unknown. Must be obtained from official partner docs before any implementation. | Unknown. Must be obtained from Firstrade docs before implementation. | Never tight-loop sync. Failed refreshes produce non-sensitive `SyncEvent` records and preserve last known good snapshots with their own freshness. |
| Field coverage | Plaid holdings can provide account, holding, security, quantity, cost basis, price, value, currency, and transaction data, but nullable fields and Firstrade-specific coverage must be confirmed. | Unknown for existing Firstrade retail-owner accounts. | Unknown. Export or statement fields are the only assumed Firstrade data source. | Required fields are symbol, quantity, currency, as-of timestamp, and source type. Missing cost basis, market value, cash, or activity must mark the snapshot `partial`. |
| Terms and permitted use | Must satisfy Plaid production access, product, data-use, retention, and user depermission terms. | Must satisfy Apex/Firstrade partner terms if such access exists. | Must satisfy Firstrade Electronic Services, account document, data access, and any API/export terms. | Website scraping, credential replay, and write-capable operations stay out of scope unless a future security-reviewed change explicitly approves them. |
| Current repo decision | First live-candidate only. | Investigation-only. | Unconfirmed. | Implement Firstrade CSV/export fallback first; revisit live connector only after owner-approved evidence proves all rows above. |

### Adapter Descriptor

Each adapter must publish non-secret metadata before it can be registered.

| Field | Required | Type | Notes |
| --- | --- | --- | --- |
| `adapterId` | yes | string | Stable ID from the adapter family table or a future broker-specific ID. |
| `brokerId` | yes | string | Stable broker key. |
| `displayName` | yes | string | Human-readable adapter name. |
| `kind` | yes | string | `live-connector`, `csv-importer`, `statement-importer`, `aggregator-candidate`, or `manual-importer`. |
| `supportedSourceTypes` | yes | string array | Source types the adapter can emit. |
| `supportedMarkets` | yes | string array | Markets this adapter can normalize. |
| `supportsHoldings` | yes | boolean | Whether current holdings can be produced. |
| `supportsCash` | yes | boolean | Whether cash balances can be produced. |
| `supportsActivity` | yes | boolean | Whether transaction/activity rows can be produced. |
| `supportsCostBasis` | yes | boolean | Whether cost basis can be produced without inference. |
| `credentialMode` | yes | string | `none`, `read-only-secret`, `owner-upload`, or `candidate-approval-required`. |
| `productionStatus` | yes | string | `fixture-only`, `dry-run`, `approved-read-only`, `import-only`, or `rejected`. |

### Allowed Operations

Adapters may expose only read/import operations. They must not expose order placement, order modification, cash movement, account mutation, or browser-session reuse operations.

| Operation | Connector | Importer | Required behavior |
| --- | --- | --- | --- |
| `describe()` | yes | yes | Return the adapter descriptor without loading secrets or files. |
| `preflight(request)` | yes | yes | Validate configuration, source type, account alias, mode, and read-only constraints without committing data. |
| `syncSnapshot(request)` | yes | no | Read broker data and return a normalized `SnapshotEnvelope` or a rejected `SyncEvent`. |
| `previewImport(request)` | no | yes | Validate owner-provided files and return a non-committed preview. |
| `commitImport(request)` | no | yes | After owner approval, normalize imported rows into a `SnapshotEnvelope`. |
| `classifyError(error)` | yes | yes | Map adapter-specific failures into `SyncEvent.errorClass`. |

### Normalization Rules

- The adapter output boundary is `SnapshotEnvelope`; downstream code must not consume broker SDK objects, raw CSV rows, raw statements, HTML, screenshots, or browser sessions.
- Broker-specific field names must be mapped into the normalized schema before storage or export.
- Missing fields must become `null`, empty arrays, or `dataQuality` flags. Adapters must not fabricate cost basis, cash, market value, P/L, or source timestamps.
- Partial data is valid only when `SourceFreshness.status` and `SnapshotEnvelope.dataQuality` clearly mark what is missing.
- Candidate live connectors for Firstrade, Plaid Investments, Apex-related sources, or future brokers stay `fixture-only` or `rejected` until their terms, consent flow, refresh behavior, and read-only field coverage are documented.
- Future brokers are accepted by adding a new adapter descriptor and adapter implementation that returns `SnapshotEnvelope`; storage, Wealthfolio export, and downstream research contracts must remain unchanged.

## Read-Only and No-Execution Guardrails

Portfolio sync is a visibility pipeline. It must refuse trading automation and broker account mutation even when an SDK, aggregator, or credential technically supports those actions.

Forbidden capabilities:

- Order placement, including market, limit, stop, option, or fund orders.
- Order cancellation or modification.
- Cash movement, withdrawals, ACH, wire, transfer, or bill-pay actions.
- Account profile, margin, beneficiary, password, 2FA, tax, statement delivery, or preference mutation.
- Authenticated broker website session scraping or browser-session reuse unless a future security-reviewed OpenSpec change explicitly approves it.
- Any LLM-generated action that requests broker mutation or direct execution.

Credential expectations:

| Credential mode | Accepted | Requirements |
| --- | --- | --- |
| `none` | yes | Fixture or local import flows only. Must not touch real broker accounts. |
| `read-only-secret` | yes | Secret scope must be documented as read-only or equivalent. Job preflight must record the accepted scope without logging values. |
| `owner-upload` | yes | Owner-provided files are treated as untrusted input and require preview approval before commit. |
| `candidate-approval-required` | no for production | Used for Plaid/Apex/Firstrade candidates until terms, consent, field coverage, and read-only behavior are approved. |
| `write-capable-secret` | no | Must be rejected before adapter initialization. |
| `browser-session` | no | Must be rejected unless a separate approved change exists. |

Refusal behavior:

| Trigger | Required response |
| --- | --- |
| Write-capable credential is configured | Refuse startup or sync with `SyncEvent.status=rejected` and `errorClass=write-capable-credential`. |
| Adapter exposes a write/mutation method | Reject adapter registration before any sync/import run. |
| User or report asks to place, cancel, or modify an order | Return a refusal that broker execution is out of scope and do not call an adapter. |
| Import file or source implies account mutation workflow | Reject the workflow as `unsafe-input` or route to a future security-reviewed change. |
| LLM output contains imperative execution language | Exclude it from portfolio sync and downstream recommendation objects. |

Operational rules:

- Refusals should be stored as non-sensitive `SyncEvent` rows so the owner can see why a run did not proceed.
- Refusal logs must include adapter ID, broker ID, account alias, and error class only. Do not log secret names when that would reveal account identity, and never log secret values.
- Read-only credential verification can be manual for the first implementation, but the adapter must still carry `credentialMode` and refusal outcomes in its descriptor or sync event.

## WealthfolioDisplayExport

Normalized export/display contract from snapshot store to Wealthfolio or a private companion artifact.

| Field | Required | Type | Notes |
| --- | --- | --- | --- |
| `exportId` | yes | string | Unique export run ID. |
| `snapshotSyncRunId` | yes | string | Source snapshot run ID. |
| `target` | yes | string | `wealthfolio-import`, `wealthfolio-api`, `manual-wealthfolio-file`, or `companion-artifact`. |
| `format` | yes | string | `csv`, `json`, `api-payload`, or `markdown`. |
| `createdAt` | yes | timestamp | Export creation time. |
| `status` | yes | string | `created`, `applied`, `failed`, `skipped`, or `manual-action-required`. |
| `freshnessStatus` | yes | string | Overall display freshness shown to the owner. |
| `includedFields` | yes | string array | Fields exported, such as holdings, cash, cost basis, market value, and P/L. |
| `omittedFields` | yes | string array | Missing or intentionally omitted fields with safe names only. |
| `artifactRef` | no | string | Private artifact path or ID. Do not expose public URLs for account data. |

## Downstream Read-Only Consumer Contract

`add-investment-research-reports` may consume portfolio context only through normalized, read-only snapshot records produced by this capability. It must not load broker credentials, raw broker payloads, raw import files, or Wealthfolio UI state.

Allowed read surfaces:

| Surface | Fields | Consumer use |
| --- | --- | --- |
| Latest account snapshots | `SnapshotEnvelope`, `BrokerAccount`, `Holding`, `CashBalance`, `SourceFreshness`, `dataQuality` | Personal portfolio review, allocation, concentration, stale-data notes, and missing-data notes. |
| Aggregate-by-symbol view | Market, symbol, currency, total quantity, market value where fresh, cost basis where available, P/L where available, source freshness, contributing account aliases | Portfolio-aware exposure and holding-relative signals after freshness gates pass. |
| Cash summary view | Currency, account alias, balance type, amount, freshness status, missing fields | Cash drag, currency exposure, and rebalance-check signals only when cash is fresh. |
| Activity context view | Activity rows, date range, activity type, symbol, amount, source type, source freshness, data-quality flags | Historical context only. Must not prove current holdings or cash. |
| Sync/freshness summary | Adapter ID, source type, sync status, error class, missing fields, as-of timestamps | Report source freshness and degradation explanations. |

Forbidden read surfaces:

- Broker credentials, CA certificates, session tokens, aggregator tokens, API tokens, secret values, or plaintext credential material.
- Raw broker SDK responses, raw CSV rows, raw statements, screenshots, HTML, or browser sessions.
- Full brokerage account numbers or account identifiers beyond `accountAlias` and `accountIdentityHash`.
- Wealthfolio UI scraping, Wealthfolio internal SQLite reads, or treating Wealthfolio as the durable source of truth.
- Import preview data that has not been owner-approved and committed.

Consumer obligations:

- Treat the snapshot store as read-only. Research jobs must not write holdings, cash, activity rows, source freshness, Wealthfolio exports, or broker account metadata.
- Apply freshness and data-quality gates before creating portfolio-aware signals or recommendation objects.
- Degrade to general-market-only reporting when required portfolio data is stale, partial, failed, unavailable, or missing.
- Include source freshness and missing-data notes when a personal portfolio section is rendered.
- Use allowlisted Telegram recipients and configured redacted/summary/detailed rendering modes for any personal portfolio report content.
- Refuse any request to load broker credentials or raw broker files with a clear message that broker access belongs to `investment-portfolio-sync`.

Minimum downstream degradation rules:

| Missing or stale data | Required behavior |
| --- | --- |
| Holdings unavailable | Suppress allocation, concentration, holding-relative strength, review-add, and review-reduce signals. |
| Cash unavailable | Suppress cash-drag and rebalance-check signals that depend on cash. |
| Cost basis unavailable | Suppress unrealized P/L, tax, and large gain/loss claims. |
| Market value unavailable | Suppress allocation percentage and exposure-size claims. |
| Activity-only source | Use only as historical context and label it as not proving current holdings. |
| Snapshot failed or unavailable | Omit personal portfolio section or render a no-current-portfolio-context note. |
