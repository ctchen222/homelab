const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { PortfolioStore, redactPortfolioLogPayload } = require("../dist/portfolioStore.js");

function minutesAgoIso(minutes) {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

function createTempStore() {
  const dir = mkdtempSync(join(tmpdir(), "finops-portfolio-store-"));
  const dbPath = join(dir, "portfolio.sqlite");
  const store = new PortfolioStore(dbPath, {
    accountIdentitySalt: "test-salt",
    writerLeaseMinutes: 1
  });
  store.init();
  return {
    dir,
    store,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function snapshot({
  syncRunId,
  brokerId = "fixture",
  accountAlias,
  accountIdentityHash,
  baseCurrency = "USD",
  asOf = minutesAgoIso(60),
  sourceTimestamp = asOf,
  sourceStatus = "fresh",
  missingFields = [],
  holdings = [],
  cashBalances = [],
  activityRows = [],
  errors = [],
  dataQuality = []
}) {
  return {
    schemaVersion: "investment-portfolio.snapshot.v1",
    syncRunId,
    brokerId,
    account: {
      brokerId,
      accountAlias,
      accountIdentityHash: accountIdentityHash || accountAlias,
      accountType: "brokerage",
      baseCurrency,
      marketScope: ["NASDAQ", "TWSE"],
      displayName: `${accountAlias} display`,
      status: "active",
      createdAt: asOf,
      updatedAt: asOf
    },
    sourceType: "live-api",
    sourceFreshness: {
      sourceType: "live-api",
      sourceName: `${brokerId}-fixture`,
      sourceTimestamp,
      fetchedAt: minutesAgoIso(0),
      committedAt: minutesAgoIso(0),
      maxAgeMinutes: 1440,
      status: sourceStatus,
      missingFields
    },
    baseCurrency,
    asOf,
    holdings,
    cashBalances,
    activityRows,
    errors,
    dataQuality
  };
}

function holding(accountAlias, overrides = {}) {
  return {
    brokerId: overrides.brokerId || "fixture",
    accountAlias,
    market: overrides.market || "NASDAQ",
    symbol: overrides.symbol || "QQQ",
    providerSymbol: overrides.providerSymbol,
    securityName: overrides.securityName || "Invesco QQQ Trust",
    assetType: overrides.assetType || "equity",
    currency: overrides.currency || "USD",
    quantity: overrides.quantity || "10",
    averageCost: overrides.averageCost,
    costBasis: overrides.costBasis,
    lastPrice: overrides.lastPrice,
    marketValue: overrides.marketValue,
    unrealizedPnl: overrides.unrealizedPnl,
    unrealizedPnlPercent: overrides.unrealizedPnlPercent,
    asOf: overrides.asOf || minutesAgoIso(60),
    freshnessStatus: overrides.freshnessStatus || "fresh",
    dataQuality: overrides.dataQuality || []
  };
}

function cash(accountAlias, overrides = {}) {
  return {
    brokerId: overrides.brokerId || "fixture",
    accountAlias,
    currency: overrides.currency || "USD",
    amount: overrides.amount || "1000",
    balanceType: overrides.balanceType || "cash",
    asOf: overrides.asOf || minutesAgoIso(60),
    freshnessStatus: overrides.freshnessStatus || "fresh",
    dataQuality: overrides.dataQuality || []
  };
}

test("portfolio store applies migrations and persists latest account snapshots", (t) => {
  const temp = createTempStore();
  t.after(() => temp.cleanup());

  assert.equal(temp.store.getMigrationVersion(), 2);

  temp.store.persistSnapshot(
    snapshot({
      syncRunId: "sync-1",
      accountAlias: "main-us",
      holdings: [holding("main-us", { quantity: "10", marketValue: "4000", costBasis: "3500", unrealizedPnl: "500" })],
      cashBalances: [cash("main-us", { amount: "250" })]
    })
  );

  const latest = temp.store.getLatestSnapshotForAccount({ brokerId: "fixture", accountAlias: "main-us" });
  assert.ok(latest);
  assert.equal(latest.account.accountAlias, "main-us");
  assert.equal(latest.holdings.length, 1);
  assert.equal(latest.cashBalances.length, 1);
  assert.notEqual(latest.account.accountIdentityHash, "main-us");
});

test("portfolio store aggregates symbols across accounts and filters stale snapshots by default", (t) => {
  const temp = createTempStore();
  t.after(() => temp.cleanup());

  temp.store.persistSnapshot(
    snapshot({
      syncRunId: "sync-agg-fresh",
      accountAlias: "us-main",
      holdings: [holding("us-main", { symbol: "QQQ", quantity: "10", marketValue: "4000", costBasis: "3500", unrealizedPnl: "500" })],
      cashBalances: [cash("us-main", { amount: "200" })]
    })
  );
  temp.store.persistSnapshot(
    snapshot({
      syncRunId: "sync-agg-second",
      accountAlias: "us-retirement",
      holdings: [holding("us-retirement", { symbol: "QQQ", quantity: "5", marketValue: "2000", costBasis: "1500", unrealizedPnl: "500" })],
      cashBalances: [cash("us-retirement", { amount: "100" })]
    })
  );
  temp.store.persistSnapshot(
    snapshot({
      syncRunId: "sync-agg-stale",
      accountAlias: "tw-main",
      baseCurrency: "TWD",
      asOf: minutesAgoIso(3 * 24 * 60),
      sourceTimestamp: minutesAgoIso(3 * 24 * 60),
      holdings: [holding("tw-main", { market: "TWSE", symbol: "2330", currency: "TWD", quantity: "30", marketValue: "900000", costBasis: "750000", unrealizedPnl: "150000", asOf: minutesAgoIso(3 * 24 * 60) })],
      cashBalances: [cash("tw-main", { currency: "TWD", amount: "10000", asOf: minutesAgoIso(3 * 24 * 60) })]
    })
  );

  const freshOnly = temp.store.getAggregateBySymbol(false);
  assert.equal(freshOnly.length, 1);
  assert.equal(freshOnly[0].symbol, "QQQ");
  assert.equal(freshOnly[0].totalQuantity, "15.00000000");
  assert.deepEqual(freshOnly[0].contributingAccounts.sort(), ["us-main", "us-retirement"]);

  const withStale = temp.store.getAggregateBySymbol(true);
  assert.equal(withStale.length, 2);
  assert.equal(withStale.find((row) => row.symbol === "2330").freshnessStatus, "stale");
});

test("portfolio store tracks partial snapshots, raw import retention, exports, and backups", (t) => {
  const temp = createTempStore();
  t.after(() => temp.cleanup());

  temp.store.persistSnapshot(
    snapshot({
      syncRunId: "sync-partial",
      accountAlias: "us-partial",
      sourceStatus: "partial",
      missingFields: ["cashBalances", "holdings.costBasis"],
      holdings: [holding("us-partial", { quantity: "3", marketValue: "1200" })],
      cashBalances: []
    })
  );

  const partialSnapshot = temp.store.getLatestSnapshotForAccount({ brokerId: "fixture", accountAlias: "us-partial" });
  assert.equal(temp.store.snapshotEffectiveFreshness(partialSnapshot), "partial");

  temp.store.recordRawImport({
    sourceType: "manual-csv",
    checksum: "sha256:raw",
    brokerId: "manual",
    accountAlias: "manual-main",
    filePath: "/tmp/manual.csv",
    retained: 0
  });
  assert.equal(temp.store.purgeExpiredRawImports(0), 1);

  const created = temp.store.createWealthfolioExportRecord({
    target: "wealthfolio-local",
    format: "json",
    snapshotSyncRunIds: ["sync-partial"],
    artifactPath: join(temp.dir, "wealthfolio-export.json"),
    freshnessStatus: "partial",
    includedFields: ["brokerId", "accountAlias", "symbol"],
    omittedFields: ["raw-imports"]
  });
  const duplicate = temp.store.createWealthfolioExportRecord({
    target: "wealthfolio-local",
    format: "json",
    snapshotSyncRunIds: ["sync-partial"],
    artifactPath: join(temp.dir, "wealthfolio-export.json"),
    freshnessStatus: "partial",
    includedFields: ["brokerId", "accountAlias", "symbol"],
    omittedFields: ["raw-imports"]
  });
  assert.equal(created.exportId, duplicate.exportId);
  assert.equal(temp.store.listRecentExports().length, 1);
  assert.equal(temp.store.purgeExpiredExports(0), 1);

  temp.store.recordBackup("portfolio-db", join(temp.dir, "portfolio.sqlite.bak"), "sha256:backup", -1);
  assert.equal(temp.store.listBackups("portfolio-db").length, 1);
  assert.equal(temp.store.purgeExpiredBackups(0), 1);
});

test("portfolio writer lock is single-writer and releases cleanly", (t) => {
  const temp = createTempStore();
  t.after(() => temp.cleanup());

  const holder = temp.store.acquireWriterLock("portfolio-sync-job");
  assert.throws(() => temp.store.acquireWriterLock("portfolio-sync-job"), /currently held/);
  temp.store.releaseWriterLock("portfolio-sync-job", holder);

  const replacement = temp.store.acquireWriterLock("portfolio-sync-job");
  assert.ok(replacement);
});

test("redaction hides holdings, cash, account hashes, and raw file data", () => {
  const redacted = redactPortfolioLogPayload({
    brokerId: "fixture",
    accountIdentityHash: "secret",
    holdings: [{ symbol: "QQQ", quantity: "10", marketValue: "4000" }],
    cashBalances: [{ amount: "500" }],
    filePath: "/private/raw.csv",
    nested: {
      errorMessage: "bad row",
      rawRows: [{ symbol: "TSLA" }]
    }
  });

  assert.equal(redacted.accountIdentityHash, "[redacted]");
  assert.equal(redacted.holdings, "[redacted]");
  assert.equal(redacted.cashBalances, "[redacted]");
  assert.equal(redacted.filePath, "[redacted]");
  assert.equal(redacted.nested.errorMessage, "[redacted]");
  assert.equal(redacted.nested.rawRows, "[redacted]");
});
