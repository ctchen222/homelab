## ADDED Requirements

### Requirement: Portfolio sync remains separate from investment research reports
The investment portfolio sync capability SHALL provide broker data acquisition, normalized portfolio storage, and Wealthfolio display integration without generating investment recommendations.

#### Scenario: Portfolio sync runs
- **WHEN** broker sync or import runs
- **THEN** it produces normalized portfolio snapshots and source freshness metadata without market-universe ingestion, news ingestion, signal generation, LLM summarization, or Telegram investment recommendations

#### Scenario: Research report consumes portfolio data
- **WHEN** `add-investment-research-reports` needs portfolio context
- **THEN** it reads only normalized snapshot records and does not access broker credentials, raw broker payloads, or raw import files

#### Scenario: Existing FinOps MVP runs
- **WHEN** the existing FinOps MVP report or Wealthfolio deployment runs
- **THEN** it does not require broker credentials or investment research report jobs

### Requirement: Broker connectors are portable
The investment portfolio sync capability SHALL isolate broker-specific integrations behind connector or importer adapters so current SinoPac and Firstrade sources can be replaced later.

#### Scenario: Broker source is synchronized
- **WHEN** SinoPac/Shioaji sync, Firstrade live connector sync, Firstrade import, or generic CSV import completes
- **THEN** the rest of the system consumes only normalized account, holding, cash, activity, and sync status records rather than broker-specific payloads

#### Scenario: User changes broker
- **WHEN** the user moves an account from SinoPac, Firstrade, or any existing broker to a new broker
- **THEN** the system supports adding a new connector or CSV importer without changing the portfolio snapshot, Wealthfolio display, or downstream research report contracts

### Requirement: Read-only broker synchronization
The investment portfolio sync capability SHALL synchronize or import brokerage account data in read-only mode and MUST NOT place trades, edit orders, move cash, or mutate broker account state.

#### Scenario: Broker adapter is implemented
- **WHEN** a broker adapter is implemented
- **THEN** its public interface exposes only read-only sync and import operations and does not expose order placement, order modification, cash movement, or account mutation methods

#### Scenario: Broker sync job starts
- **WHEN** a broker sync job starts
- **THEN** it loads only read-only credentials and refuses to start when configured with write-capable trading credentials

#### Scenario: Write-capable broker operation is requested
- **WHEN** any workflow requests order placement, order modification, cash movement, or broker account mutation
- **THEN** the system refuses the operation and records that write-capable broker actions are out of scope

### Requirement: SinoPac Taiwan broker connector
The investment portfolio sync capability SHALL support read-only synchronization for the user's SinoPac Taiwan stock account through Shioaji or an owner-approved equivalent path.

#### Scenario: SinoPac positions are available
- **WHEN** the SinoPac connector successfully reads stock positions
- **THEN** the system stores normalized Taiwan holdings with broker, account alias, market, symbol, quantity, average cost where available, last price or market value where available, unrealized P/L where available, currency, source timestamp, and source freshness

#### Scenario: SinoPac account balance is available
- **WHEN** the SinoPac connector successfully reads cash or account balance data
- **THEN** the system stores normalized cash balance snapshots with broker, account alias, currency, amount, source timestamp, and sync status

#### Scenario: SinoPac API permission is unavailable
- **WHEN** Shioaji account setup or permissions do not allow a read-only account endpoint
- **THEN** the system marks SinoPac sync unavailable or partial and supports owner-provided CSV import as fallback

### Requirement: Firstrade US broker data
The investment portfolio sync capability SHALL support Firstrade US account data through an owner-approved read-only connector when available and owner-provided exports as fallback.

#### Scenario: Firstrade live connector is investigated
- **WHEN** the implementation evaluates Plaid Investments, Apex-related aggregation, Firstrade-approved APIs, or another owner-approved read-only path
- **THEN** it documents authentication, consent, 2FA, refresh support, pricing, rate limits, field coverage, terms, and whether holdings, balances, transactions, and cost basis are available

#### Scenario: Firstrade live connector is approved
- **WHEN** an official or owner-approved Firstrade read-only integration path is confirmed
- **THEN** the system may add a connector that reads holdings and balances without enabling order placement or account mutation

#### Scenario: Firstrade export is imported
- **WHEN** the user provides a supported Firstrade positions, balances, account history, statement, or gain/loss export
- **THEN** the system validates the file, generates a preview, requires owner approval, and normalizes supported rows into the portfolio snapshot store

#### Scenario: Firstrade export lacks current positions
- **WHEN** a Firstrade export contains transactions, account history, or prior-year gain/loss data but does not verify current holdings and cash
- **THEN** the system records the import as activity or partial portfolio context and does not mark it as a verified current holdings snapshot

#### Scenario: Firstrade web login automation is proposed
- **WHEN** an implementation path requires automated login to Firstrade's web UI or reuse of browser sessions
- **THEN** the system rejects that path unless the owner explicitly approves a separate security-reviewed change

### Requirement: Broker file import safety
The investment portfolio sync capability SHALL treat broker CSV, statements, and spreadsheet-like imports as untrusted sensitive input.

#### Scenario: Broker file is submitted
- **WHEN** a broker CSV or account export is submitted for import
- **THEN** the system validates file type, expected headers, row count, date range, account alias, currency, source type, symbol format, numeric ranges, and required fields before writing normalized snapshots

#### Scenario: Import preview is generated
- **WHEN** a broker file passes initial validation
- **THEN** the system generates an import preview showing detected source type, account alias, date range, row counts, holdings count, cash rows, activity rows, skipped rows, and missing fields

#### Scenario: Import preview is not approved
- **WHEN** the user has not approved the import preview
- **THEN** the system does not commit normalized holdings, cash, or activity rows from that import

#### Scenario: Formula-like cell is found
- **WHEN** an imported text field begins with spreadsheet formula characters such as `=`, `+`, `-`, or `@`
- **THEN** the system escapes or rejects the value before storing or rendering it in any CSV, spreadsheet, HTML, Wealthfolio export, Telegram, or report output

#### Scenario: Duplicate file is imported
- **WHEN** a broker file with the same checksum and account alias has already been imported
- **THEN** the system treats the import as idempotent and does not duplicate holdings, cash, activity, snapshots, or Wealthfolio exports

#### Scenario: Raw broker file is not needed
- **WHEN** a broker import has been validated and committed and raw-file retention is not explicitly enabled
- **THEN** the system deletes the raw broker export and retains only normalized snapshots, checksums, and import metadata

### Requirement: Normalized portfolio snapshot store
The investment portfolio sync capability SHALL store normalized portfolio snapshots that can be read by Wealthfolio display integration and downstream research reports.

#### Scenario: Snapshot envelope is stored
- **WHEN** a broker connector or importer produces a snapshot
- **THEN** it stores a versioned snapshot envelope with schema version, sync run ID, broker ID, account alias, account identity hash, source type, base currency, as-of timestamp, holdings, cash balances, activity rows when applicable, errors, and freshness status

#### Scenario: Account identifier is stored
- **WHEN** an account identifier is stored or rendered
- **THEN** the system uses an owner-defined alias or salted hash and does not store or display the full brokerage account number as a normal identifier

#### Scenario: Multiple brokers report the same symbol
- **WHEN** the same symbol appears in more than one broker account
- **THEN** the system preserves account-level holdings and also provides an aggregate view by symbol, market, and currency

#### Scenario: Snapshot data is stale
- **WHEN** a portfolio snapshot is older than the configured freshness threshold
- **THEN** Wealthfolio display metadata and downstream consumers mark affected data as stale or unavailable

### Requirement: Wealthfolio display integration
The investment portfolio sync capability SHALL display or export normalized portfolio snapshots through Wealthfolio without making Wealthfolio the only durable source of broker state.

#### Scenario: Wealthfolio display path is configured
- **WHEN** the owner selects a Wealthfolio import, export, API, or companion dashboard path
- **THEN** the system documents the path and uses normalized portfolio snapshots as the source data

#### Scenario: Wealthfolio receives portfolio data
- **WHEN** normalized snapshots are exported or synced to Wealthfolio
- **THEN** the displayed portfolio includes holdings, cash, market value, cost basis, P/L, and currency only where those fields are available and fresh

#### Scenario: Wealthfolio cannot display freshness metadata
- **WHEN** Wealthfolio cannot natively display broker, source type, as-of timestamp, partial-data status, or stale-data status
- **THEN** the system provides a private companion artifact or dashboard with those metadata fields

#### Scenario: Wealthfolio data is used by research reports
- **WHEN** a downstream research report needs portfolio context
- **THEN** it reads the normalized snapshot store rather than scraping Wealthfolio UI or treating Wealthfolio as the source of truth

### Requirement: Secure credentials and private data handling
The investment portfolio sync capability SHALL protect broker credentials, account identifiers, holdings, cash balances, raw imports, and Wealthfolio export artifacts behind the private FinOps boundary.

#### Scenario: Credential is configured
- **WHEN** broker or aggregator credentials are configured
- **THEN** they are stored in Kubernetes secrets or an equivalent private secret store and are not committed to the repo

#### Scenario: Helm values are configured
- **WHEN** Helm values or GitOps manifests configure portfolio sync credentials
- **THEN** they reference existing secrets or encrypted secret resources and do not contain plaintext API keys, CA certificate passwords, session tokens, aggregator tokens, or broker account secrets

#### Scenario: Log is written
- **WHEN** broker sync, import, storage, or Wealthfolio export logs an event
- **THEN** the log redacts credentials, full account numbers, sensitive broker payloads, holdings payloads, cash balances, and raw import rows

#### Scenario: Sensitive data is purged
- **WHEN** the user requests deletion or retention expires
- **THEN** raw imports, sensitive artifacts, expired snapshots, and Wealthfolio export artifacts are purged according to the documented retention policy
