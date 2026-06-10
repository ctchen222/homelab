## 1. Scope and Contracts

- [x] 1.1 Document the boundary between FinOps MVP, portfolio sync, and investment research reports. <!-- openspec.nvim:task-id=tsk_boundary_scope_contract -->
- [x] 1.2 Add an implementation gate that keeps portfolio sync disabled or fixture-only until the `add-lightweight-finops-app` Wealthfolio baseline is ready. <!-- openspec.nvim:task-id=tsk_portfolio_sync_baseline_gate -->
- [x] 1.3 Define normalized broker account, holding, cash balance, activity row, snapshot envelope, sync event, source freshness, and Wealthfolio display/export schemas. <!-- openspec.nvim:task-id=tsk_normalized_portfolio_schemas -->
- [x] 1.4 Define the broker adapter contract so SinoPac, Firstrade, generic CSV, Plaid/Apex candidates, and future brokers produce the same normalized `SnapshotEnvelope`. <!-- openspec.nvim:task-id=tsk_broker_adapter_contract -->
- [x] 1.5 Define source types: live API, CSV current-position snapshot, CSV cash snapshot, statement import, transaction history, prior-year gain/loss, partial activity-only import, and manual CSV. <!-- openspec.nvim:task-id=tsk_source_type_contract -->
- [x] 1.6 Define source freshness rules for broker snapshots, cash balances, imported files, Wealthfolio exports, and stale/partial display states. <!-- openspec.nvim:task-id=tsk_source_freshness_rules -->
- [x] 1.7 Define no-trade-execution guardrails, read-only credential expectations, and refusal behavior for broker write-capable operations. <!-- openspec.nvim:task-id=tsk_read_only_guardrails -->
- [x] 1.8 Define the downstream read-only contract consumed by `add-investment-research-reports`. <!-- openspec.nvim:task-id=tsk_downstream_read_only_contract -->

## 2. Broker Read-Only Sync and Import

- [x] 2.1 Add a broker connector/importer interface that supports read-only sync, file import, sync status, source timestamp, and error classification. <!-- openspec.nvim:task-id=tsk_broker_connector_importer_interface -->
- [x] 2.2 Add a broker adapter registry that can select connectors by broker ID and account source without changing storage, Wealthfolio display, or downstream report contracts. <!-- openspec.nvim:task-id=tsk_broker_adapter_registry -->
- [x] 2.3 Implement fixture-backed broker sync for holdings, cash balances, partial data, and failed sync states without real credentials. <!-- openspec.nvim:task-id=tsk_fixture_broker_sync -->
- [x] 2.4 Implement SinoPac/Shioaji read-only stock position sync in dry-run mode. <!-- openspec.nvim:task-id=tsk_sinopac_shioaji_dry_run_positions -->
- [x] 2.5 Implement SinoPac/Shioaji cash or account balance sync where account permissions and endpoints support it. <!-- openspec.nvim:task-id=tsk_sinopac_shioaji_cash_balance_sync -->
- [x] 2.6 Add SinoPac CSV fallback importer for positions and balances. <!-- openspec.nvim:task-id=tsk_sinopac_csv_importer -->
- [x] 2.7 Investigate Firstrade live connector candidates: Plaid Investments, Apex-related aggregation, or Firstrade-approved read-only account data paths. <!-- openspec.nvim:task-id=tsk_firstrade_live_connector_investigation -->
- [x] 2.8 Document Firstrade live connector feasibility, including consent, 2FA, refresh, pricing, rate limits, field coverage, and terms. <!-- openspec.nvim:task-id=tsk_firstrade_live_feasibility_matrix -->
- [x] 2.9 Implement Firstrade CSV/export/statement fallback import for current positions, balances, transaction history, or gain/loss data based on the export format the user can provide. <!-- openspec.nvim:task-id=tsk_firstrade_csv_export_importer -->
- [x] 2.10 Implement a generic manual CSV importer for future broker migration. <!-- openspec.nvim:task-id=tsk_manual_csv_importer -->
- [x] 2.11 Reject broker website session scraping unless a future security-reviewed change explicitly approves it. <!-- openspec.nvim:task-id=tsk_reject_website_session_scraping -->
- [x] 2.12 Add tests for successful sync, missing credentials, write-capable credential refusal, failed authentication, partial data, stale data, and write-capable operation refusal. <!-- openspec.nvim:task-id=tsk_importer_and_sync_safety_tests -->

## 3. Import Safety

- [x] 3.1 Add import preflight validation for file type, expected headers, account alias, date range, currency, row count, required fields, source type, symbol format, numeric ranges, encoding, delimiter, and path constraints. <!-- openspec.nvim:task-id=tsk_import_preflight_validation -->
- [x] 3.2 Add import preview output before writing normalized snapshots. <!-- openspec.nvim:task-id=tsk_import_preview -->
- [x] 3.3 Require owner approval before committing imported holdings, cash, or activity rows. <!-- openspec.nvim:task-id=tsk_owner_approval_before_commit -->
- [x] 3.4 Add CSV/formula injection protection for imported text fields before storing or rendering them. <!-- openspec.nvim:task-id=tsk_import_formula_injection_protection -->
- [x] 3.5 Add import checksums and idempotency so repeated imports do not duplicate holdings, cash, activity, snapshots, or Wealthfolio exports. <!-- openspec.nvim:task-id=tsk_import_checksum_idempotency -->
- [x] 3.6 Add raw import retention and deletion rules, with delete-after-commit as the default. <!-- openspec.nvim:task-id=tsk_raw_import_retention_rules -->
- [x] 3.7 Add tests for malformed CSV, safety-limit rejection, duplicate import, formula-like cells, partial activity-only import, stale import, raw-file deletion, and preview rejection. <!-- openspec.nvim:task-id=tsk_import_safety_tests -->

## 4. Portfolio Snapshot Store

- [x] 4.1 Add a separate SQLite-backed investment portfolio store for broker accounts, portfolio snapshots, holdings, cash balances, activity rows, sync events, source freshness, and Wealthfolio export metadata.
- [x] 4.2 Add database migrations and a single-writer job policy for scheduled broker sync and import jobs.
- [x] 4.3 Add account-level and aggregate-by-symbol portfolio views.
- [x] 4.4 Add account identity handling with owner-defined aliases or salted hashes, never full brokerage account numbers as normal identifiers.
- [x] 4.5 Add retention, purge, and backup rules for snapshots, raw imports, and export artifacts.
- [x] 4.6 Add redaction rules for logs that include broker account identifiers, credential names, holdings payloads, cash balances, import errors, and raw file rows.
- [x] 4.7 Add tests for snapshot creation, multi-account aggregation, stale snapshot handling, retention, purge, backup metadata, redaction, and partial-data behavior.

## 5. Wealthfolio Display Integration

- [x] 5.1 Confirm the safest Wealthfolio ingestion/display path: supported import format, API/import adapter, or private companion dashboard plus manual Wealthfolio import.
- [x] 5.2 Add a Wealthfolio-compatible export or sync adapter from normalized snapshots.
- [x] 5.3 Preserve normalized snapshot store as source of truth and treat Wealthfolio as display/import target.
- [x] 5.4 Display or expose broker, account alias, source type, as-of timestamp, sync status, stale/partial labels, currency, holdings, cash, market value, cost basis, and P/L where available.
- [x] 5.5 Provide a private companion artifact or dashboard when Wealthfolio cannot natively display source freshness or partial-data metadata.
- [x] 5.6 Add tests for Wealthfolio export rendering, stale/partial metadata, missing cost basis, missing cash, multi-currency holdings, and no duplicate exports.

## 6. Deployment and Operations

- [x] 6.1 Add Docker Compose or local script support for fixture-backed portfolio sync and Wealthfolio export without real broker credentials.
- [x] 6.2 Add Helm values and templates for disabled-by-default broker sync/import jobs, portfolio store PVC, and Wealthfolio export/sync jobs.
- [x] 6.3 Add Helm/GitOps configuration that references existing secrets or encrypted secret resources and never stores plaintext broker credentials, CA certificate passwords, session tokens, aggregator tokens, or account secrets in values.
- [x] 6.4 Add Kubernetes secret key documentation for SinoPac/Shioaji credentials, approved Firstrade/Plaid/Apex connector credentials if used, import configuration, and Wealthfolio display/export configuration.
- [x] 6.5 Add operations runbook steps for enabling SinoPac sync, validating Firstrade live connector candidates, importing Firstrade exports, rotating/revoking secrets, restoring snapshots, purging sensitive artifacts, and disabling the capability without deleting data.
- [x] 6.6 Verify local fixture runs, OpenSpec validation, unit tests, Helm lint, and Helm template rendering.
- [x] 6.7 Verify k3d deployment of jobs, PVCs, secrets, ConfigMaps, resource limits, and failure states before VPS enablement.

## 7. User Validation Gates

- [x] 7.1 Keep all real-data jobs disabled until fixture run, dry-run sync/import validation, redacted preview, owner approval, and scheduled enablement gates are completed.
- [x] 7.2 Confirm which SinoPac read-only endpoints are available in the user's account setup after Shioaji login.
- [x] 7.3 Confirm whether Firstrade can be connected through Plaid Investments, Apex-related aggregation, or another owner-approved read-only connector.
- [x] 7.4 Confirm which Firstrade export/statement files the user can reliably download and whether their fields include symbol, quantity, cost basis, market value, cash, currency, and as-of date. <!-- openspec.nvim:task-id=tsk_firstrade_export_field_validation -->
- [x] 7.5 Confirm whether the Firstrade export is a current-position snapshot or only transaction/gain-loss history. <!-- openspec.nvim:task-id=tsk_firstrade_export_snapshot_classification -->
- [x] 7.6 Confirm the Wealthfolio display/import path before enabling scheduled sync/export.
- [x] 7.7 Review the first Wealthfolio display or export with real or sanitized account data before marking portfolio sync production-ready.
