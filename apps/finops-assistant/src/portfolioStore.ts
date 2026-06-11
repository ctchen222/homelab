import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  BrokerAccount,
  CashBalance,
  FreshnessStatus,
  PortfolioHolding,
  ActivityRow,
  SNAPSHOT_SCHEMA_VERSION,
  SourceFreshness,
  SnapshotEnvelope,
  SyncEvent,
  PortfolioSourceType
} from "./portfolioSync";

type RedactableInput = unknown;

export interface PortfolioStoreOptions {
  accountIdentitySalt?: string;
  writerLeaseMinutes?: number;
}

export interface AccountIdentity {
  brokerId: string;
  accountAlias: string;
}

export interface PortfolioStoreRetentionOptions {
  snapshotRetentionDays?: number;
  exportRetentionDays?: number;
  rawImportRetentionDays?: number;
}

export interface WealthfolioExportRecord {
  exportId: string;
  target: string;
  format: "csv" | "json" | "api-payload" | "markdown";
  status: "created" | "applied" | "failed" | "skipped" | "manual-action-required";
  freshnessStatus: FreshnessStatus;
  includedFields: string[];
  omittedFields: string[];
  snapshotSyncRunIds: string[];
  artifactPath: string;
  requestSignature: string;
  createdAt: string;
}

export interface PortfolioAggregateRow {
  market: string;
  symbol: string;
  currency: string;
  totalQuantity: string;
  totalMarketValue: string;
  totalCostBasis: string;
  totalUnrealizedPnl: string;
  contributingAccounts: string[];
  freshnessStatus: FreshnessStatus;
}

export interface PortfolioAccountSummary {
  brokerId: string;
  accountAlias: string;
  baseCurrency: string;
  asOf: string;
  freshnessStatus: FreshnessStatus;
  holdingsMarketValue: string;
  holdingsCostBasis: string;
  unrealizedPnl: string;
  cashBalance: string;
  totalAssets: string;
}

export interface PortfolioStoreWriter {
  acquireWriterLock(jobName: string): string;
  releaseWriterLock(jobName: string, holder: string): void;
}

export interface PortfolioStoreBackup {
  backupId: string;
  kind: string;
  path: string;
  checksum?: string;
  createdAt: string;
  expiresAt: string;
}

interface SnapshotPersistenceInput {
  now: string;
}

interface ImportMetadata {
  sourceType: PortfolioSourceType;
  checksum: string;
  brokerId: string;
  accountAlias: string;
  filePath: string;
  retained: 0 | 1;
  createdAt: string;
  deletedAt?: string;
}

interface Migration {
  version: number;
  sql: string;
}

const DEFAULT_OPTIONS: Required<PortfolioStoreOptions> = {
  accountIdentitySalt: "",
  writerLeaseMinutes: 30
};

const DEFAULT_RETENTION_DAYS = {
  snapshot: 30,
  exports: 90,
  rawImports: 90
};

const REDACTED_TEXT = "[redacted]";
const SENSITIVE_LOG_KEYS = new Set([
  "securityName",
  "quantity",
  "averageCost",
  "costBasis",
  "lastPrice",
  "marketValue",
  "unrealizedPnl",
  "unrealizedPnlPercent",
  "amount",
  "rawRows",
  "raw_row",
  "rawRowsCsv",
  "filePath",
  "path",
  "error",
  "errorMessage",
  "balances",
  "holdings",
  "cashBalances",
  "activityRows",
  "dataQuality",
  "accountIdentityHash"
]);

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS portfolio_schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS portfolio_accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        broker_id TEXT NOT NULL,
        account_alias TEXT NOT NULL,
        account_identity_hash TEXT NOT NULL,
        account_type TEXT,
        base_currency TEXT NOT NULL,
        market_scope_json TEXT NOT NULL,
        display_name TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (broker_id, account_alias),
        UNIQUE (account_identity_hash)
      );

      CREATE TABLE IF NOT EXISTS portfolio_sync_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sync_run_id TEXT NOT NULL UNIQUE,
        broker_id TEXT NOT NULL,
        account_alias TEXT NOT NULL,
        account_identity_hash TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_name TEXT NOT NULL,
        source_timestamp TEXT,
        fetched_at TEXT NOT NULL,
        committed_at TEXT,
        max_age_minutes INTEGER NOT NULL,
        freshness_status TEXT NOT NULL,
        reason TEXT,
        missing_fields_json TEXT NOT NULL,
        schema_version TEXT NOT NULL,
        base_currency TEXT NOT NULL,
        as_of TEXT NOT NULL,
        data_quality_json TEXT NOT NULL,
        errors_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (broker_id, account_alias) REFERENCES portfolio_accounts (broker_id, account_alias) ON DELETE RESTRICT,
        FOREIGN KEY (account_identity_hash) REFERENCES portfolio_accounts (account_identity_hash) ON DELETE RESTRICT
      );

      CREATE TABLE IF NOT EXISTS portfolio_holdings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sync_run_id TEXT NOT NULL,
        broker_id TEXT NOT NULL,
        account_alias TEXT NOT NULL,
        market TEXT NOT NULL,
        symbol TEXT NOT NULL,
        provider_symbol TEXT,
        security_name TEXT,
        asset_type TEXT NOT NULL,
        currency TEXT NOT NULL,
        quantity TEXT NOT NULL,
        average_cost TEXT,
        cost_basis TEXT,
        last_price TEXT,
        market_value TEXT,
        unrealized_pnl TEXT,
        unrealized_pnl_percent TEXT,
        as_of TEXT NOT NULL,
        freshness_status TEXT NOT NULL,
        data_quality_json TEXT NOT NULL,
        UNIQUE (sync_run_id, broker_id, account_alias, symbol, market, as_of),
        FOREIGN KEY (sync_run_id) REFERENCES portfolio_sync_runs (sync_run_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS portfolio_cash_balances (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sync_run_id TEXT NOT NULL,
        broker_id TEXT NOT NULL,
        account_alias TEXT NOT NULL,
        currency TEXT NOT NULL,
        amount TEXT NOT NULL,
        balance_type TEXT NOT NULL,
        as_of TEXT NOT NULL,
        freshness_status TEXT NOT NULL,
        data_quality_json TEXT NOT NULL,
        UNIQUE (sync_run_id, broker_id, account_alias, currency, balance_type, as_of),
        FOREIGN KEY (sync_run_id) REFERENCES portfolio_sync_runs (sync_run_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS portfolio_activity_rows (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sync_run_id TEXT NOT NULL,
        broker_id TEXT NOT NULL,
        account_alias TEXT NOT NULL,
        activity_id TEXT NOT NULL,
        activity_type TEXT NOT NULL,
        trade_date TEXT,
        settle_date TEXT,
        market TEXT,
        symbol TEXT,
        currency TEXT NOT NULL,
        quantity TEXT,
        price TEXT,
        amount TEXT,
        amount_type TEXT,
        source_description TEXT,
        as_of TEXT NOT NULL,
        data_quality_json TEXT NOT NULL,
        UNIQUE (sync_run_id, activity_id),
        FOREIGN KEY (sync_run_id) REFERENCES portfolio_sync_runs (sync_run_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS portfolio_sync_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sync_run_id TEXT NOT NULL,
        broker_id TEXT NOT NULL,
        account_alias TEXT NOT NULL,
        adapter_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL,
        error_class TEXT,
        row_counts_json TEXT NOT NULL,
        artifact_refs_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (sync_run_id),
        FOREIGN KEY (sync_run_id) REFERENCES portfolio_sync_runs (sync_run_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS portfolio_writer_locks (
        job_name TEXT PRIMARY KEY,
        holder_id TEXT NOT NULL,
        locked_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS portfolio_raw_imports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_type TEXT NOT NULL,
        checksum TEXT NOT NULL,
        broker_id TEXT NOT NULL,
        account_alias TEXT NOT NULL,
        file_path TEXT NOT NULL,
        retained INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        deleted_at TEXT
      );

      CREATE TABLE IF NOT EXISTS portfolio_wealthfolio_exports (
        export_id TEXT PRIMARY KEY,
        request_signature TEXT NOT NULL UNIQUE,
        target TEXT NOT NULL,
        format TEXT NOT NULL,
        created_at TEXT NOT NULL,
        freshness_status TEXT NOT NULL,
        status TEXT NOT NULL,
        included_fields_json TEXT NOT NULL,
        omitted_fields_json TEXT NOT NULL,
        artifact_path TEXT NOT NULL,
        snapshot_sync_run_ids_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS portfolio_backups (
        backup_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        checksum TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_portfolio_sync_runs_account
        ON portfolio_sync_runs (broker_id, account_alias, created_at);
      CREATE INDEX IF NOT EXISTS idx_portfolio_holdings_sync
        ON portfolio_holdings (sync_run_id, market, symbol);
      CREATE INDEX IF NOT EXISTS idx_portfolio_cash_sync
        ON portfolio_cash_balances (sync_run_id, currency);
      CREATE INDEX IF NOT EXISTS idx_portfolio_activity_sync
        ON portfolio_activity_rows (sync_run_id, trade_date);
      CREATE INDEX IF NOT EXISTS idx_portfolio_events_sync
        ON portfolio_sync_events (sync_run_id);
      CREATE INDEX IF NOT EXISTS idx_portfolio_exports_status
        ON portfolio_wealthfolio_exports (status, created_at);
      CREATE INDEX IF NOT EXISTS idx_portfolio_backups_kind
        ON portfolio_backups (kind, expires_at);
    `
  },
  {
    version: 2,
    sql: `
      CREATE VIEW IF NOT EXISTS vw_latest_portfolio_snapshots AS
      WITH ranked AS (
        SELECT
          sync_run_id,
          broker_id,
          account_alias,
          created_at,
          ROW_NUMBER() OVER (
            PARTITION BY broker_id, account_alias
            ORDER BY created_at DESC
          ) AS rn
        FROM portfolio_sync_runs
      )
      SELECT sync_run_id
      FROM ranked
      WHERE rn = 1;
    `
  }
];

export class PortfolioStore {
  private readonly dbPath: string;
  private readonly options: Required<PortfolioStoreOptions>;

  constructor(dbPath: string, options: PortfolioStoreOptions = {}) {
    this.dbPath = dbPath;
    this.options = {
      ...DEFAULT_OPTIONS,
      ...options
    };
  }

  init(): void {
    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.run("PRAGMA foreign_keys = ON;");
    this.applyMigrations();
  }

  applyMigrations(): void {
    this.run(`
      CREATE TABLE IF NOT EXISTS portfolio_schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
    const current = this.getMigrationVersion();
    for (const migration of MIGRATIONS.filter((item) => item.version > current)) {
      this.run(migration.sql);
      this.run(`INSERT INTO portfolio_schema_migrations (version, applied_at) VALUES (${migration.version}, ${quote(this.now())});`);
    }
  }

  getMigrationVersion(): number {
    try {
      const rows = this.queryLines("SELECT COALESCE(MAX(version), 0) FROM portfolio_schema_migrations;");
      if (rows.length === 0 || !rows[0]) return 0;
      const parsed = Number.parseInt(rows[0], 10);
      return Number.isNaN(parsed) ? 0 : parsed;
    } catch {
      return 0;
    }
  }

  recordRawImport(metadata: Omit<ImportMetadata, "createdAt">): void {
    const createdAt = this.now();
    const fields = [
      quote(metadata.sourceType),
      quote(metadata.checksum),
      quote(metadata.brokerId),
      quote(metadata.accountAlias),
      quote(metadata.filePath),
      metadata.retained ? "1" : "0",
      quote(createdAt)
    ];
    this.run(`
      INSERT INTO portfolio_raw_imports (source_type, checksum, broker_id, account_alias, file_path, retained, created_at)
      VALUES (${fields.join(", ")});
    `);
  }

  purgeExpiredRawImports(retentionDays = DEFAULT_RETENTION_DAYS.rawImports): number {
    const cutoff = this.isoDaysBefore(retentionDays);
    const removed = Number.parseInt(this.queryScalar(`SELECT COUNT(1) FROM portfolio_raw_imports WHERE created_at < ${quote(cutoff)};`), 10);
    this.run(`DELETE FROM portfolio_raw_imports WHERE created_at < ${quote(cutoff)};`);
    return Number.isNaN(removed) ? 0 : removed;
  }

  persistSnapshot(snapshot: SnapshotEnvelope, syncEvent?: SyncEvent): void {
    const now = this.now();
    const syncRunId = sanitizeText(snapshot.syncRunId);
    const exists = this.queryScalar(`SELECT COUNT(1) FROM portfolio_sync_runs WHERE sync_run_id = ${quote(syncRunId)};`);
    if (exists === "0") {
      const holder = this.acquireWriterLock("portfolio-sync-writer");
      try {
        this.persistAccount(snapshot.account, now);
        this.persistSyncRun(snapshot, now);
      this.persistSyncRunChildren(snapshot);
        if (syncEvent) {
          this.persistSyncEvent(syncEvent, now);
        }
      } finally {
        this.releaseWriterLock("portfolio-sync-writer", holder);
      }
      return;
    }

    if (syncEvent) {
      const signature = this.syncEventSignature(syncEvent);
      const existing = this.queryScalar(`SELECT sync_run_id FROM portfolio_sync_events WHERE sync_run_id=${quote(syncRunId)} AND artifact_refs_json LIKE ${quote(`%${signature}%`)};`);
      if (!existing) {
        this.persistSyncEvent(syncEvent, now);
      }
    }
  }

  getLatestSnapshotForAccount(account: AccountIdentity): SnapshotEnvelope | undefined {
    const syncRunId = this.queryScalar(`
      SELECT sync_run_id FROM vw_latest_portfolio_snapshots
      WHERE sync_run_id IN (
        SELECT sync_run_id FROM portfolio_sync_runs
        WHERE broker_id = ${quote(account.brokerId)} AND account_alias = ${quote(account.accountAlias)}
      )
      LIMIT 1;
    `);
    if (!syncRunId) return undefined;
    return this.getSnapshotBySyncRunId(syncRunId);
  }

  getLatestSnapshots(): SnapshotEnvelope[] {
    const rows = this.queryLines("SELECT sync_run_id FROM vw_latest_portfolio_snapshots;");
    return rows.map((syncRunId) => this.getSnapshotBySyncRunId(syncRunId)).filter((value): value is SnapshotEnvelope => Boolean(value));
  }

  getSnapshotBySyncRunId(syncRunId: string): SnapshotEnvelope | undefined {
    const snapshotRows = this.queryLines(`
      SELECT
        sync_run_id || char(9) ||
        broker_id || char(9) ||
        account_alias || char(9) ||
        account_identity_hash || char(9) ||
        source_type || char(9) ||
        source_name || char(9) ||
        COALESCE(source_timestamp, "") || char(9) ||
        fetched_at || char(9) ||
        COALESCE(committed_at, "") || char(9) ||
        max_age_minutes || char(9) ||
        freshness_status || char(9) ||
        COALESCE(reason, "") || char(9) ||
        missing_fields_json || char(9) ||
        schema_version || char(9) ||
        base_currency || char(9) ||
        as_of || char(9) ||
        data_quality_json || char(9) ||
        errors_json
      FROM portfolio_sync_runs
      WHERE sync_run_id = ${quote(syncRunId)};
    `);
    if (snapshotRows.length === 0) return undefined;

    const [
      rawSyncRunId,
      brokerId,
      accountAlias,
      accountIdentityHash,
      sourceType,
      sourceName,
      sourceTimestamp,
      fetchedAt,
      committedAt,
      maxAgeMinutes,
      sourceStatus,
      reason,
      missingFieldsRaw,
      schemaVersion,
      baseCurrency,
      asOf,
      dataQualityRaw,
      errorsRaw
    ] = snapshotRows[0].split("\t");

    if (!rawSyncRunId || !brokerId || !accountAlias) return undefined;

    const accountRows = this.queryLines(`
      SELECT
        account_type || char(9) ||
        market_scope_json || char(9) ||
        COALESCE(display_name, "") || char(9) ||
        status || char(9) ||
        created_at || char(9) ||
        updated_at
      FROM portfolio_accounts
      WHERE broker_id = ${quote(brokerId)} AND account_alias = ${quote(accountAlias)};
    `);
    if (accountRows.length === 0) return undefined;

    const [accountType, marketScopeRaw, displayName, accountStatus, createdAt, updatedAt] = accountRows[0].split("\t");
    const holdings = this.getHoldingsBySyncRun(syncRunId);
    const cashBalances = this.getCashBySyncRun(syncRunId);
    const activityRows = this.getActivitiesBySyncRun(syncRunId);

    const sourceFreshness: SourceFreshness = {
      sourceType: sourceType as PortfolioSourceType,
      sourceName,
      sourceTimestamp: sourceTimestamp || undefined,
      fetchedAt,
      committedAt: committedAt || undefined,
      maxAgeMinutes: Number.parseInt(maxAgeMinutes, 10),
      status: sourceStatus as FreshnessStatus,
      reason: reason || undefined,
      missingFields: parseJsonArray<string>(missingFieldsRaw)
    };

    const account: BrokerAccount = {
      brokerId,
      accountAlias,
      accountIdentityHash,
      accountType,
      baseCurrency,
      marketScope: parseJsonArray<string>(marketScopeRaw),
      displayName: displayName || undefined,
      status: accountStatus as BrokerAccount["status"],
      createdAt,
      updatedAt
    };

    return {
      schemaVersion: schemaVersion as SnapshotEnvelope["schemaVersion"],
      syncRunId: rawSyncRunId,
      brokerId,
      account,
      sourceType: sourceType as PortfolioSourceType,
      sourceFreshness,
      baseCurrency,
      asOf,
      holdings,
      cashBalances,
      activityRows,
      errors: parseJsonArray<SnapshotEnvelope["errors"][number]>(errorsRaw),
      dataQuality: parseJsonArray<string>(dataQualityRaw)
    };
  }

  getAggregateBySymbol(includePartialOrStale = false): PortfolioAggregateRow[] {
    const snapshots = this.getLatestSnapshots();
    const aggregate: Record<string, PortfolioAggregateRow> = {};

    for (const snapshot of snapshots) {
      const effectiveStatus = this.snapshotEffectiveFreshness(snapshot);
      if (effectiveStatus === "failed" || effectiveStatus === "unavailable") {
        continue;
      }
      if (!includePartialOrStale && effectiveStatus !== "fresh") continue;

      for (const holding of snapshot.holdings) {
        const key = `${holding.market}|${holding.symbol}|${holding.currency}`;
        aggregate[key] ??= {
          market: holding.market,
          symbol: holding.symbol,
          currency: holding.currency,
          totalQuantity: "0",
          totalMarketValue: "0",
          totalCostBasis: "0",
          totalUnrealizedPnl: "0",
          contributingAccounts: [],
          freshnessStatus: effectiveStatus
        };
        const row = aggregate[key];
        row.totalQuantity = sumAsText(row.totalQuantity, holding.quantity);
        row.totalMarketValue = sumAsText(row.totalMarketValue, holding.marketValue || "0");
        row.totalCostBasis = sumAsText(row.totalCostBasis, holding.costBasis || "0");
        row.totalUnrealizedPnl = sumAsText(row.totalUnrealizedPnl, holding.unrealizedPnl || "0");
        if (!row.contributingAccounts.includes(snapshot.account.accountAlias)) {
          row.contributingAccounts.push(snapshot.account.accountAlias);
        }
      }
    }

    return Object.values(aggregate).sort((a, b) => `${a.market}|${a.symbol}`.localeCompare(`${b.market}|${b.symbol}`));
  }

  getAccountSummaries(includePartialOrStale = false): PortfolioAccountSummary[] {
    return this.getLatestSnapshots()
      .flatMap((snapshot) => {
        const freshnessStatus = this.snapshotEffectiveFreshness(snapshot);
        if (freshnessStatus === "failed" || freshnessStatus === "unavailable") return [];
        if (!includePartialOrStale && freshnessStatus !== "fresh") return [];

        let holdingsMarketValue = "0";
        let holdingsCostBasis = "0";
        let unrealizedPnl = "0";
        let cashBalance = "0";

        for (const holding of snapshot.holdings) {
          holdingsMarketValue = sumAsText(holdingsMarketValue, holding.marketValue || "0");
          holdingsCostBasis = sumAsText(holdingsCostBasis, holding.costBasis || "0");
          unrealizedPnl = sumAsText(unrealizedPnl, holding.unrealizedPnl || "0");
        }

        for (const cash of snapshot.cashBalances) {
          cashBalance = sumAsText(cashBalance, cash.amount || "0");
        }

        return [
          {
            brokerId: snapshot.brokerId,
            accountAlias: snapshot.account.accountAlias,
            baseCurrency: snapshot.baseCurrency,
            asOf: snapshot.asOf,
            freshnessStatus,
            holdingsMarketValue,
            holdingsCostBasis,
            unrealizedPnl,
            cashBalance,
            totalAssets: sumAsText(holdingsMarketValue, cashBalance)
          }
        ];
      })
      .sort((a, b) => `${a.brokerId}|${a.accountAlias}`.localeCompare(`${b.brokerId}|${b.accountAlias}`));
  }

  purgeExpiredSnapshots(retentionDays = DEFAULT_RETENTION_DAYS.snapshot): number {
    const cutoff = this.isoDaysBefore(retentionDays);
    const removed = Number.parseInt(this.queryScalar(`SELECT COUNT(1) FROM portfolio_sync_runs WHERE created_at < ${quote(cutoff)};`), 10);
    this.run(`DELETE FROM portfolio_sync_runs WHERE created_at < ${quote(cutoff)};`);
    return Number.isNaN(removed) ? 0 : removed;
  }

  purgeExpiredExports(retentionDays = DEFAULT_RETENTION_DAYS.exports): number {
    const cutoff = this.isoDaysBefore(retentionDays);
    const removed = Number.parseInt(
      this.queryScalar(`SELECT COUNT(1) FROM portfolio_wealthfolio_exports WHERE created_at < ${quote(cutoff)};`),
      10
    );
    this.run(`DELETE FROM portfolio_wealthfolio_exports WHERE created_at < ${quote(cutoff)};`);
    return Number.isNaN(removed) ? 0 : removed;
  }

  purgeExpiredBackups(retentionDays = DEFAULT_RETENTION_DAYS.exports): number {
    const cutoff = this.isoDaysBefore(retentionDays);
    const removed = Number.parseInt(this.queryScalar(`SELECT COUNT(1) FROM portfolio_backups WHERE expires_at < ${quote(cutoff)};`), 10);
    this.run(`DELETE FROM portfolio_backups WHERE expires_at < ${quote(cutoff)};`);
    return Number.isNaN(removed) ? 0 : removed;
  }

  recordBackup(kind: string, path: string, checksum?: string, retentionDays = DEFAULT_RETENTION_DAYS.exports): PortfolioStoreBackup {
    const createdAt = this.now();
    const expiresAt = this.isoDaysAfter(retentionDays);
    const backupId = `backup-${this.randomId()}`;
    const checksumSql = checksum ? quote(checksum) : "NULL";
    this.run(`
      INSERT INTO portfolio_backups (backup_id, kind, path, checksum, created_at, expires_at)
      VALUES (${quote(backupId)}, ${quote(kind)}, ${quote(path)}, ${checksumSql}, ${quote(createdAt)}, ${quote(expiresAt)});
    `);

    return {
      backupId,
      kind,
      path,
      checksum,
      createdAt,
      expiresAt
    };
  }

  listBackups(kind?: string): PortfolioStoreBackup[] {
    const where = kind ? `WHERE kind = ${quote(kind)}` : "";
    const rows = this.queryLines(`SELECT backup_id || char(9) || kind || char(9) || path || char(9) || COALESCE(checksum, "") || char(9) || created_at || char(9) || expires_at FROM portfolio_backups ${where} ORDER BY created_at DESC;`);
    return rows.map((row) => {
      const [backupId, backupKind, path, checksum, createdAt, expiresAt] = row.split("\t");
      return {
        backupId,
        kind: backupKind,
        path,
        checksum: checksum || undefined,
        createdAt,
        expiresAt
      };
    });
  }

  createWealthfolioExportRecord(options: {
    target: string;
    format: WealthfolioExportRecord["format"];
    snapshotSyncRunIds: string[];
    artifactPath: string;
    freshnessStatus: FreshnessStatus;
    includedFields: string[];
    omittedFields: string[];
    status?: WealthfolioExportRecord["status"];
  }): WealthfolioExportRecord {
    const createdAt = this.now();
    const signatureSource = JSON.stringify({
      target: options.target,
      format: options.format,
      snapshotSyncRunIds: options.snapshotSyncRunIds.slice().sort(),
      includedFields: options.includedFields.slice().sort(),
      omittedFields: options.omittedFields.slice().sort()
    });
    const requestSignature = createHash("sha256").update(signatureSource).digest("hex");
    const status = options.status || "created";
    const includedFieldsJson = JSON.stringify(options.includedFields);
    const omittedFieldsJson = JSON.stringify(options.omittedFields);

    const existing = this.queryScalar(
      `SELECT export_id FROM portfolio_wealthfolio_exports WHERE request_signature = ${quote(requestSignature)} LIMIT 1;`
    );
    if (existing) {
      const rows = this.queryLines(`
        SELECT export_id, target, format, created_at, freshness_status, status, included_fields_json, omitted_fields_json, artifact_path, snapshot_sync_run_ids_json
        FROM portfolio_wealthfolio_exports
        WHERE request_signature = ${quote(requestSignature)};
      `);
      if (rows.length > 0) {
        const [exportId, target, format, createdAt, freshnessStatus, rowStatus, included, omitted, artifactPath, snapshotIdsJson] = rows[0].split("\t");
        return {
          exportId,
          target,
          format: format as WealthfolioExportRecord["format"],
          createdAt,
          freshnessStatus: freshnessStatus as FreshnessStatus,
          status: rowStatus as WealthfolioExportRecord["status"],
          includedFields: parseJsonArray<string>(included),
          omittedFields: parseJsonArray<string>(omitted),
          artifactPath,
          requestSignature,
          snapshotSyncRunIds: parseJsonArray<string>(snapshotIdsJson)
        };
      }
    }

    const exportId = `wealthfolio-${this.randomId()}`;
    this.run(`
      INSERT INTO portfolio_wealthfolio_exports (
        export_id,
        request_signature,
        target,
        format,
        created_at,
        freshness_status,
        status,
        included_fields_json,
        omitted_fields_json,
        artifact_path,
        snapshot_sync_run_ids_json
      ) VALUES (
        ${quote(exportId)},
        ${quote(requestSignature)},
        ${quote(options.target)},
        ${quote(options.format)},
        ${quote(createdAt)},
        ${quote(options.freshnessStatus)},
        ${quote(status)},
        ${quote(includedFieldsJson)},
        ${quote(omittedFieldsJson)},
        ${quote(options.artifactPath)},
        ${quote(JSON.stringify(options.snapshotSyncRunIds))}
      );
    `);

    return {
      exportId,
      target: options.target,
      format: options.format,
      createdAt,
      freshnessStatus: options.freshnessStatus,
      status,
      includedFields: options.includedFields,
      omittedFields: options.omittedFields,
      artifactPath: options.artifactPath,
      requestSignature,
      snapshotSyncRunIds: options.snapshotSyncRunIds
    };
  }

  listRecentExports(limit = 20): WealthfolioExportRecord[] {
    const rows = this.queryLines(`
      SELECT
        export_id,
        target,
        format,
        created_at,
        freshness_status,
        status,
        included_fields_json,
        omitted_fields_json,
        artifact_path,
        request_signature,
        snapshot_sync_run_ids_json
      FROM portfolio_wealthfolio_exports
      ORDER BY created_at DESC
      LIMIT ${Number(limit)};
    `);

    return rows.map((row) => {
      const [exportId, target, format, createdAt, freshnessStatus, status, includedFields, omittedFields, artifactPath, requestSignature, snapshotSyncRunIds] = row.split("\t");
      return {
        exportId,
        target,
        format: format as WealthfolioExportRecord["format"],
        status: status as WealthfolioExportRecord["status"],
        freshnessStatus: freshnessStatus as FreshnessStatus,
        includedFields: parseJsonArray<string>(includedFields),
        omittedFields: parseJsonArray<string>(omittedFields),
        artifactPath,
        requestSignature,
        snapshotSyncRunIds: parseJsonArray<string>(snapshotSyncRunIds),
        createdAt
      };
    });
  }

  acquireWriterLock(jobName: string): string {
    const holder = this.randomId();
    const now = this.now();
    const expiresAt = this.isoMinutesAfter(this.options.writerLeaseMinutes);
    const cleanup = new Date(Date.parse(expiresAt) - this.options.writerLeaseMinutes * 60 * 1000).toISOString();
    this.run(`DELETE FROM portfolio_writer_locks WHERE expires_at < ${quote(cleanup)};`);
    try {
      this.run(`
        INSERT INTO portfolio_writer_locks (job_name, holder_id, locked_at, expires_at)
        VALUES (${quote(jobName)}, ${quote(holder)}, ${quote(now)}, ${quote(expiresAt)});
      `);
      return holder;
    } catch {
      throw new Error(`Writer lock for ${jobName} is currently held.`);
    }
  }

  releaseWriterLock(jobName: string, holder: string): void {
    this.run(`DELETE FROM portfolio_writer_locks WHERE job_name = ${quote(jobName)} AND holder_id = ${quote(holder)};`);
  }

  snapshotEffectiveFreshness(snapshot: SnapshotEnvelope, now = this.now()): FreshnessStatus {
    const status = snapshot.sourceFreshness.status;
    if (status === "failed" || status === "unavailable") return status;

    const anchor = snapshot.sourceFreshness.sourceTimestamp || snapshot.asOf;
    if (!anchor) return "partial";
    const ageMinutes = (Date.parse(now) - Date.parse(anchor)) / 60000;
    if (Number.isNaN(ageMinutes)) return "partial";
    if (ageMinutes > snapshot.sourceFreshness.maxAgeMinutes) return "stale";
    return status;
  }

  redactLogPayload(payload: unknown): unknown {
    return redactPortfolioLogPayload(payload);
  }

  private persistSyncRun(snapshot: SnapshotEnvelope, createdAt: string): void {
    const now = createdAt;
    const accountIdentityHash = this.ensureAccountIdentityHash(snapshot.account);
    const payload = [
      quote(snapshot.syncRunId),
      quote(snapshot.brokerId),
      quote(snapshot.account.accountAlias),
      quote(accountIdentityHash),
      quote(snapshot.sourceType),
      quote(snapshot.sourceFreshness.sourceName),
      quote(snapshot.sourceFreshness.sourceTimestamp || ""),
      quote(snapshot.sourceFreshness.fetchedAt),
      quote(snapshot.sourceFreshness.committedAt || now),
      String(snapshot.sourceFreshness.maxAgeMinutes),
      quote(snapshot.sourceFreshness.status),
      snapshot.sourceFreshness.reason ? quote(snapshot.sourceFreshness.reason) : "NULL",
      quote(JSON.stringify(snapshot.sourceFreshness.missingFields)),
      quote(snapshot.schemaVersion),
      quote(snapshot.baseCurrency),
      quote(snapshot.asOf),
      quote(JSON.stringify(snapshot.dataQuality)),
      quote(JSON.stringify(snapshot.errors)),
      quote(now)
    ];
    this.run(`
      INSERT INTO portfolio_sync_runs (
        sync_run_id,
        broker_id,
        account_alias,
        account_identity_hash,
        source_type,
        source_name,
        source_timestamp,
        fetched_at,
        committed_at,
        max_age_minutes,
        freshness_status,
        reason,
        missing_fields_json,
        schema_version,
        base_currency,
        as_of,
        data_quality_json,
        errors_json,
        created_at
      ) VALUES (${payload.join(", ")});
    `);
  }

  private persistSyncEvent(syncEvent: SyncEvent, createdAt: string): void {
    this.run(`
      INSERT INTO portfolio_sync_events (
        sync_run_id,
        broker_id,
        account_alias,
        adapter_id,
        mode,
        started_at,
        finished_at,
        status,
        error_class,
        row_counts_json,
        artifact_refs_json,
        created_at
      ) VALUES (
        ${quote(syncEvent.syncRunId)},
        ${quote(syncEvent.brokerId)},
        ${quote(syncEvent.accountAlias)},
        ${quote(syncEvent.adapterId)},
        ${quote(syncEvent.mode)},
        ${quote(syncEvent.startedAt)},
        ${quote(syncEvent.finishedAt || createdAt)},
        ${quote(syncEvent.status)},
        ${syncEvent.errorClass ? quote(syncEvent.errorClass) : "NULL"},
        ${quote(JSON.stringify(syncEvent.rowCounts))},
        ${quote(JSON.stringify(syncEvent.artifactRefs))},
        ${quote(createdAt)}
      )
      ON CONFLICT(sync_run_id) DO UPDATE SET
        status = excluded.status,
        error_class = excluded.error_class,
        row_counts_json = excluded.row_counts_json,
        artifact_refs_json = excluded.artifact_refs_json,
        finished_at = excluded.finished_at;
    `);
  }

  private persistAccount(account: BrokerAccount, createdAt: string): void {
    const accountIdentityHash = this.ensureAccountIdentityHash(account);
    this.run(`
      INSERT INTO portfolio_accounts (
        broker_id,
        account_alias,
        account_identity_hash,
        account_type,
        base_currency,
        market_scope_json,
        display_name,
        status,
        created_at,
        updated_at
      ) VALUES (
        ${quote(account.brokerId)},
        ${quote(account.accountAlias)},
        ${quote(accountIdentityHash)},
        ${quote(account.accountType || "broker")},
        ${quote(account.baseCurrency)},
        ${quote(JSON.stringify(account.marketScope))},
        ${quote(account.displayName || account.accountAlias)},
        ${quote(account.status)},
        ${quote(createdAt)},
        ${quote(createdAt)}
      )
      ON CONFLICT(broker_id, account_alias) DO UPDATE SET
        account_identity_hash = excluded.account_identity_hash,
        account_type = excluded.account_type,
        base_currency = excluded.base_currency,
        market_scope_json = excluded.market_scope_json,
        display_name = excluded.display_name,
        status = excluded.status,
        updated_at = excluded.updated_at;
    `);
  }

  private persistSyncRunChildren(snapshot: SnapshotEnvelope): void {
    for (const holding of snapshot.holdings) {
      this.run(`
        INSERT INTO portfolio_holdings (
          sync_run_id,
          broker_id,
          account_alias,
          market,
          symbol,
          provider_symbol,
          security_name,
          asset_type,
          currency,
          quantity,
          average_cost,
          cost_basis,
          last_price,
          market_value,
          unrealized_pnl,
          unrealized_pnl_percent,
          as_of,
          freshness_status,
          data_quality_json
        ) VALUES (
          ${quote(snapshot.syncRunId)},
          ${quote(holding.brokerId)},
          ${quote(holding.accountAlias)},
          ${quote(holding.market)},
          ${quote(holding.symbol)},
          ${quote(holding.providerSymbol || "")},
          ${quote(holding.securityName || "")},
          ${quote(holding.assetType)},
          ${quote(holding.currency)},
          ${quote(holding.quantity)},
          ${quote(holding.averageCost || "")},
          ${quote(holding.costBasis || "")},
          ${quote(holding.lastPrice || "")},
          ${quote(holding.marketValue || "")},
          ${quote(holding.unrealizedPnl || "")},
          ${quote(holding.unrealizedPnlPercent || "")},
          ${quote(holding.asOf)},
          ${quote(holding.freshnessStatus)},
          ${quote(JSON.stringify(holding.dataQuality))}
        );
      `);
    }

    for (const cashBalance of snapshot.cashBalances) {
      this.run(`
        INSERT INTO portfolio_cash_balances (
          sync_run_id,
          broker_id,
          account_alias,
          currency,
          amount,
          balance_type,
          as_of,
          freshness_status,
          data_quality_json
        ) VALUES (
          ${quote(snapshot.syncRunId)},
          ${quote(cashBalance.brokerId)},
          ${quote(cashBalance.accountAlias)},
          ${quote(cashBalance.currency)},
          ${quote(cashBalance.amount)},
          ${quote(cashBalance.balanceType)},
          ${quote(cashBalance.asOf)},
          ${quote(cashBalance.freshnessStatus)},
          ${quote(JSON.stringify(cashBalance.dataQuality))}
        );
      `);
    }

    for (const activity of snapshot.activityRows) {
      this.run(`
        INSERT INTO portfolio_activity_rows (
          sync_run_id,
          broker_id,
          account_alias,
          activity_id,
          activity_type,
          trade_date,
          settle_date,
          market,
          symbol,
          currency,
          quantity,
          price,
          amount,
          amount_type,
          source_description,
          as_of,
          data_quality_json
        ) VALUES (
          ${quote(snapshot.syncRunId)},
          ${quote(activity.brokerId)},
          ${quote(activity.accountAlias)},
          ${quote(activity.activityId)},
          ${quote(activity.activityType)},
          ${quote(activity.tradeDate || "")},
          ${quote(activity.settleDate || "")},
          ${quote(activity.market || "")},
          ${quote(activity.symbol || "")},
          ${quote(activity.currency)},
          ${quote(activity.quantity || "")},
          ${quote(activity.price || "")},
          ${quote(activity.amount || "")},
          ${quote(activity.amountType || "unknown")},
          ${quote(activity.sourceDescription || "")},
          ${quote(activity.asOf)},
          ${quote(JSON.stringify(activity.dataQuality))}
        );
      `);
    }
  }

  private getHoldingsBySyncRun(syncRunId: string): PortfolioHolding[] {
    const rows = this.queryLines(`
      SELECT
        broker_id,
        account_alias,
        market,
        symbol,
        provider_symbol,
        security_name,
        asset_type,
        currency,
        quantity,
        average_cost,
        cost_basis,
        last_price,
        market_value,
        unrealized_pnl,
        unrealized_pnl_percent,
        as_of,
        freshness_status,
        data_quality_json
      FROM portfolio_holdings
      WHERE sync_run_id = ${quote(syncRunId)}
      ORDER BY market, symbol;
    `);
    return rows.map((row) => {
      const [
        brokerId,
        accountAlias,
        market,
        symbol,
        providerSymbol,
        securityName,
        assetType,
        currency,
        quantity,
        averageCost,
        costBasis,
        lastPrice,
        marketValue,
        unrealizedPnl,
        unrealizedPnlPercent,
        asOf,
        freshnessStatus,
        dataQuality
      ] = row.split("\t");

      return {
        brokerId,
        accountAlias,
        market,
        symbol,
        providerSymbol: providerSymbol || undefined,
        securityName: securityName || undefined,
        assetType: assetType as PortfolioHolding["assetType"],
        currency,
        quantity,
        averageCost: averageCost || undefined,
        costBasis: costBasis || undefined,
        lastPrice: lastPrice || undefined,
        marketValue: marketValue || undefined,
        unrealizedPnl: unrealizedPnl || undefined,
        unrealizedPnlPercent: unrealizedPnlPercent || undefined,
        asOf,
        freshnessStatus: freshnessStatus as FreshnessStatus,
        dataQuality: parseJsonArray<string>(dataQuality)
      };
    });
  }

  private getCashBySyncRun(syncRunId: string): CashBalance[] {
    const rows = this.queryLines(`
      SELECT
        broker_id,
        account_alias,
        currency,
        amount,
        balance_type,
        as_of,
        freshness_status,
        data_quality_json
      FROM portfolio_cash_balances
      WHERE sync_run_id = ${quote(syncRunId)}
      ORDER BY currency;
    `);
    return rows.map((row) => {
      const [brokerId, accountAlias, currency, amount, balanceType, asOf, freshnessStatus, dataQuality] = row.split("\t");
      return {
        brokerId,
        accountAlias,
        currency,
        amount,
        balanceType: balanceType as CashBalance["balanceType"],
        asOf,
        freshnessStatus: freshnessStatus as FreshnessStatus,
        dataQuality: parseJsonArray<string>(dataQuality)
      };
    });
  }

  private getActivitiesBySyncRun(syncRunId: string): ActivityRow[] {
    const rows = this.queryLines(`
      SELECT
        broker_id,
        account_alias,
        activity_id,
        activity_type,
        trade_date,
        settle_date,
        market,
        symbol,
        currency,
        quantity,
        price,
        amount,
        amount_type,
        source_description,
        as_of,
        data_quality_json
      FROM portfolio_activity_rows
      WHERE sync_run_id = ${quote(syncRunId)}
      ORDER BY as_of DESC, symbol;
    `);
    return rows.map((row) => {
      const [
        brokerId,
        accountAlias,
        activityId,
        activityType,
        tradeDate,
        settleDate,
        market,
        symbol,
        currency,
        quantity,
        price,
        amount,
        amountType,
        sourceDescription,
        asOf,
        dataQuality
      ] = row.split("\t");

      return {
        brokerId,
        accountAlias,
        activityId,
        activityType: activityType as ActivityRow["activityType"],
        tradeDate: tradeDate || undefined,
        settleDate: settleDate || undefined,
        market: market || undefined,
        symbol: symbol || undefined,
        currency,
        quantity: quantity || undefined,
        price: price || undefined,
        amount: amount || undefined,
        amountType: (amountType || "unknown") as ActivityRow["amountType"],
        sourceDescription: sourceDescription || undefined,
        asOf,
        dataQuality: parseJsonArray<string>(dataQuality)
      };
    });
  }

  private syncEventSignature(syncEvent: SyncEvent): string {
    return createHash("sha256")
      .update(JSON.stringify({
        syncRunId: syncEvent.syncRunId,
        brokerId: syncEvent.brokerId,
        accountAlias: syncEvent.accountAlias,
        adapterId: syncEvent.adapterId,
        status: syncEvent.status
      }))
      .digest("hex");
  }

  private isoDaysBefore(days: number): string {
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  }

  private isoDaysAfter(days: number): string {
    return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  }

  private isoMinutesAfter(minutes: number): string {
    return new Date(Date.now() + minutes * 60 * 1000).toISOString();
  }

  private now(): string {
    return new Date().toISOString();
  }

  private randomId(): string {
    return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}-` +
      createHash("sha256").update(`${Date.now()}-${Math.random()}`).digest("hex").slice(0, 12);
  }

  private run(sql: string): void {
    execFileSync("sqlite3", [this.dbPath, sql], { stdio: "pipe" });
  }

  private queryScalar(sql: string): string {
    const value = execFileSync("sqlite3", [this.dbPath, sql], { encoding: "utf8" }).trim();
    return value;
  }

  private queryLines(sql: string): string[] {
    const output = execFileSync("sqlite3", ["-separator", "\t", this.dbPath, sql], { encoding: "utf8" }).trim();
    if (!output) {
      return [];
    }
    return output.split("\n");
  }

  private ensureAccountIdentityHash(account: BrokerAccount): string {
    const provided = sanitizeText(account.accountIdentityHash || "");
    if (provided && provided !== account.accountAlias) {
      return provided;
    }

    return createHash("sha256")
      .update(`${this.options.accountIdentitySalt}|${account.brokerId}|${account.accountAlias}`)
      .digest("hex");
  }
}

function quote(value: string): string {
  if (typeof value !== "string") {
    value = String(value);
  }
  return `'${value.replace(/'/g, "''")}'`;
}

function parseJsonArray<T>(value: string | undefined): T[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((entry) => entry as T) : [];
  } catch {
    return [];
  }
}

function sumAsText(base: string, value: string): string {
  const parsedBase = Number.parseFloat(base);
  const parsedValue = Number.parseFloat(value);
  const total = (Number.isFinite(parsedBase) ? parsedBase : 0) + (Number.isFinite(parsedValue) ? parsedValue : 0);
  return total.toFixed(8);
}

export function sanitizeText(value: string): string {
  return (value || "").trim();
}

export function redactPortfolioLogPayload(input: RedactableInput): unknown {
  if (input === null || typeof input !== "object") return input;
  if (Array.isArray(input)) {
    return input.map((entry) => {
      if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean" || entry === null) {
        return entry;
      }
      return typeof entry === "object" ? redactPortfolioLogPayload(entry as RedactableInput) : entry;
    });
  }
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (SENSITIVE_LOG_KEYS.has(key) || key.toLowerCase().includes("accountidentity")) {
      output[key] = REDACTED_TEXT;
      continue;
    }

    if (value === null || typeof value !== "object") {
      output[key] = value;
      continue;
    }

      if (Array.isArray(value)) {
      output[key] = value.map((entry) =>
        typeof entry === "object" && entry !== null ? redactPortfolioLogPayload(entry as RedactableInput) : entry
      );
      continue;
    }

    output[key] = typeof value === "object" ? redactPortfolioLogPayload(value as RedactableInput) : value;
  }
  return output;
}

export function snapshotId(account: BrokerAccount): string {
  const base = `${account.brokerId}|${account.accountAlias}|${account.createdAt || "unknown"}`;
  return base;
}
