## Context

`add-lightweight-finops-app` owns the FinOps MVP: bookkeeping integrations, the assistant/reporting surface, and Wealthfolio deployment. It does not define how real broker holdings are synchronized, normalized, validated, or displayed.

This change adds the next foundation layer: investment portfolio sync. It collects broker data in read-only mode, stores normalized portfolio snapshots, and exposes those snapshots to Wealthfolio and future consumers. It deliberately does not generate investment recommendations.

The separation is intentional:

| Area | `add-lightweight-finops-app` owns first | `add-investment-intelligence-broker-sync` owns after | `add-investment-research-reports` owns later |
| --- | --- | --- | --- |
| Finance base | ezBookkeeping, assistant, daily finance reports, Wealthfolio deployment | Consumes deployed private FinOps platform | Consumes private report/Telegram surface |
| Portfolio data | Wealthfolio availability and manual/imported visual surface | Broker-neutral normalized snapshots and freshness | Read-only portfolio context for research |
| Broker integration | No broker sync | SinoPac/Firstrade/future broker read-only connectors/importers | No broker credentials or broker mutation |
| Wealthfolio | Runs the app | Displays normalized portfolio snapshots | May link to portfolio context but does not write holdings |
| Market research | Small watchlist commentary in MVP | Out of scope | Market universe, news, signals, recommendations |
| LLM report | Basic FinOps text where already implemented | Out of scope | LLM summarization after deterministic evidence/policy |

Current broker assumptions:

- Taiwan brokerage: SinoPac Securities through Shioaji where read-only account permissions support it.
- US brokerage: Firstrade Securities.
- Firstrade live connector is not assumed. The implementation should investigate approved read-only paths such as Plaid Investments, Apex-related aggregation, or Firstrade-approved APIs, and keep CSV/export import as fallback.
- SinoPac and Firstrade are first sources, not permanent architectural assumptions. Later broker migration must only require a new adapter/importer.
- Broker integration starts and remains read-only. Trade placement, order modification, withdrawals, cash movement, and account mutation are out of scope.

## Goals / Non-Goals

**Goals:**

- Sync or import the user's SinoPac Taiwan stock account and Firstrade US account into normalized read-only portfolio snapshots.
- Keep broker connectors replaceable so future account migration does not require rewriting storage, Wealthfolio display, or downstream research report contracts.
- Provide clear source freshness, source type, sync status, and partial-data labels.
- Validate broker CSV/account exports before committing snapshots.
- Display the normalized portfolio in Wealthfolio or through a Wealthfolio-compatible import/export path.
- Keep broker credentials, account identifiers, holdings, raw exports, and sync artifacts behind the private FinOps boundary.

**Non-Goals:**

- Do not place trades, edit orders, move cash, or mutate broker accounts.
- Do not generate investment recommendations or daily investment research reports.
- Do not ingest market-wide data, news, official filings, RSS feeds, or popular market themes.
- Do not ask an LLM to analyze portfolio data.
- Do not make Wealthfolio the source of truth for recommendations.
- Do not scrape authenticated broker web pages as the default integration strategy.

## Decisions

### Decision 1: Keep portfolio sync separate from research reports

This change only owns broker data acquisition, normalization, storage, freshness, and Wealthfolio display. `add-investment-research-reports` will consume the normalized snapshots later.

Rationale:

- Broker sync is a sensitive data correctness and credential problem.
- Research reports are a market data, news, LLM, and recommendation policy problem.
- Separating them lets the owner verify holdings in Wealthfolio before trusting any report.

### Decision 2: Use enforceable read-only broker adapters

Broker adapters must expose only read/import operations. The adapter interface must not expose order placement, order modification, cash movement, or account mutation methods. Sync jobs must refuse write-capable trading credentials.

Rationale:

- The user wants portfolio visibility, not automated execution.
- Read-only sync reduces blast radius inside the homelab.
- Future execution features, if ever desired, require a separate security-reviewed OpenSpec change.

### Decision 3: Use a broker adapter registry and SnapshotEnvelope

Broker-specific code should live behind a connector/importer registry. Downstream storage, Wealthfolio display, and future research reports should consume a versioned `SnapshotEnvelope` only.

Initial adapters:

- `sinopac-shioaji`: read-only API connector for Taiwan stock positions and cash/account balance where supported.
- `sinopac-csv`: fallback importer for Taiwan positions and balances.
- `firstrade-live-candidate`: placeholder for an owner-approved Plaid Investments, Apex-related, or official Firstrade read-only connector after feasibility is confirmed.
- `firstrade-csv`: first fallback US account importer from owner-provided Firstrade exports/statements.
- `manual-csv`: generic fallback for future broker transfers.

`SnapshotEnvelope` should contain schema version, sync run ID, broker ID, account alias, account identity hash, source type, base currency, as-of timestamp, holdings, cash balances, errors, and freshness status.

### Decision 4: Use Shioaji for SinoPac Taiwan read-only data where available

The SinoPac connector should use Shioaji account and portfolio APIs where the user's account permissions support them. Initial sync should read positions, average price/cost where available, last price or market value where available, unrealized P/L where available, cash/account balance where available, and source timestamp.

If Shioaji account setup or permissions do not allow a required read-only endpoint, the system should mark SinoPac sync unavailable or partial and offer SinoPac CSV import as fallback.

### Decision 5: Treat Firstrade as live-connector candidate plus CSV fallback

The plan should not assume a stable public Firstrade read-only account API until verified. It should first investigate:

- Plaid Investments support for Firstrade or Apex-carried Firstrade accounts.
- Any Firstrade-approved read-only account data path.
- Authentication, consent, 2FA, refresh support, pricing, rate limits, field coverage, and terms.

Until an approved live connector is confirmed, Firstrade data enters through owner-provided exports or statements. If an export only contains transactions, account history, or prior-year gain/loss, the import must be labeled partial/activity-only and must not be treated as verified current holdings.

CSV/import workflow:

1. The user logs in to Firstrade manually.
2. The user downloads an account export, statement, or CSV.
3. The user places it in a private import location or uploads it through a private admin path.
4. The importer validates file type, headers, account alias, date range, currency, source type, row count, symbol format, numeric ranges, and required fields.
5. The importer generates a preview.
6. The user approves the preview.
7. The importer commits normalized holdings/cash/activity rows.
8. Raw files are deleted by default unless retention is explicitly enabled.

### Decision 6: Store normalized snapshots outside Wealthfolio

The normalized portfolio snapshot store is the source of truth for portfolio sync and downstream research. Wealthfolio is a display surface. The Wealthfolio adapter may export/import normalized snapshots into Wealthfolio, or use a supported Wealthfolio ingestion path, but it should not make Wealthfolio the only durable copy of broker state.

Rationale:

- Wealthfolio is useful for visual inspection.
- Broker snapshots need source freshness, sync status, partial-data labels, and retention controls that may not map cleanly to Wealthfolio.
- Future reports need a stable read-only contract independent of Wealthfolio internals.

### Decision 7: Display data quality clearly in Wealthfolio

Wealthfolio should show or be accompanied by private metadata for:

- Broker and account alias.
- Source type: live API, CSV current snapshot, CSV activity-only, statement import, manual CSV.
- As-of timestamp.
- Fresh, stale, partial, failed, or unavailable sync status.
- Holdings, cash, market value, cost basis, and P/L only where available and fresh.
- TWD/USD currency exposure where enough data exists.

If Wealthfolio cannot display all metadata natively, the implementation should provide a private companion artifact or dashboard linked from the portfolio view.

## Risks / Trade-offs

- [Risk] Firstrade live connector may not be available or may require a paid aggregator. -> Mitigation: keep CSV/export fallback and make live connector optional.
- [Risk] CSV exports may not prove current holdings. -> Mitigation: source-type labels, preview approval, and partial-data status.
- [Risk] Broker credentials are sensitive. -> Mitigation: use existing secrets/encrypted secrets, redact logs, and reject write-capable credentials.
- [Risk] Wealthfolio and snapshot store can become conflicting sources of truth. -> Mitigation: normalized snapshot store remains source of truth; Wealthfolio is display/import target.
- [Risk] Raw broker exports contain sensitive data. -> Mitigation: validate as untrusted input, delete by default after import, and document retention if enabled.

## Migration Plan

1. Finish the `add-lightweight-finops-app` Wealthfolio and assistant baseline.
2. Define broker adapter, import, snapshot, freshness, and Wealthfolio display contracts.
3. Implement fixture-backed broker sync and Wealthfolio display/export path.
4. Implement SinoPac/Shioaji dry-run sync.
5. Implement SinoPac CSV fallback.
6. Investigate Firstrade live connector candidates, including Plaid Investments/Apex/Firstrade-approved paths.
7. Implement Firstrade CSV/export fallback with preview approval.
8. Add private storage, retention, redaction, and backup rules.
9. Deploy disabled-by-default jobs and enable one source at a time after owner approval.

Rollback strategy:

- Disable broker sync/import jobs.
- Preserve normalized snapshots unless the owner explicitly purges them.
- Disable Wealthfolio sync/export while keeping raw normalized snapshots.
- Downstream research reports must degrade to no-portfolio-context when snapshots are unavailable.

## Open Questions

- Which SinoPac read-only endpoints are available in the user's Shioaji account setup?
- Can Firstrade or Apex-carried Firstrade accounts be connected through Plaid Investments with holdings, balances, transactions, and refresh support?
- Which Firstrade export or statement format can the user reliably provide?
- Which Wealthfolio ingestion/display path is safest: file import, API/import adapter, or companion dashboard plus manual Wealthfolio import?
- What retention period should apply to normalized snapshots, raw imports, and Wealthfolio export artifacts?
