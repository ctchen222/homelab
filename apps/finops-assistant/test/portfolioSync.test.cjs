const test = require("node:test");
const assert = require("node:assert/strict");
const {
  BrokerAdapterRegistry,
  SNAPSHOT_SCHEMA_VERSION,
  classifyBrokerSyncError,
  validateReadOnlyDescriptor
} = require("../dist/portfolioSync.js");
const { createFixtureBrokerConnector } = require("../dist/portfolioSyncFixtures.js");

function baseDescriptor(overrides = {}) {
  return {
    adapterId: "fixture-broker",
    brokerId: "fixture",
    displayName: "Fixture Broker",
    kind: "live-connector",
    supportedSourceTypes: ["live-api"],
    supportedMarkets: ["TWSE", "NASDAQ"],
    supportsHoldings: true,
    supportsCash: true,
    supportsActivity: false,
    supportsCostBasis: true,
    credentialMode: "read-only-secret",
    productionStatus: "dry-run",
    ...overrides
  };
}

test("validates read-only adapter descriptors", () => {
  assert.deepEqual(validateReadOnlyDescriptor(baseDescriptor()), { ok: true, status: "succeeded" });
});

test("rejects write-capable broker credentials before sync", () => {
  const result = validateReadOnlyDescriptor(baseDescriptor({ credentialMode: "write-capable-secret" }));

  assert.equal(result.ok, false);
  assert.equal(result.status, "rejected");
  assert.equal(result.errorClass, "write-capable-credential");
});

test("classifies broker sync errors into stable error classes", () => {
  assert.equal(classifyBrokerSyncError(new Error("missing broker token")), "missing-credentials");
  assert.equal(classifyBrokerSyncError(new Error("too many requests from provider")), "rate-limited");
  assert.equal(classifyBrokerSyncError(new Error("code: 406, detail: Account Not Acceptable")), "permission-denied");
  assert.equal(classifyBrokerSyncError(new Error("SinoPac stock account is not signed for Shioaji API")), "permission-denied");
  assert.equal(classifyBrokerSyncError({ errorClass: "auth-failed" }), "auth-failed");
  assert.equal(classifyBrokerSyncError(new Error("unmapped provider failure")), "unknown");
});

test("connector interface can return a normalized snapshot with source timestamp", async () => {
  const descriptor = baseDescriptor();
  const connector = {
    describe: () => descriptor,
    preflight: () => validateReadOnlyDescriptor(descriptor),
    syncSnapshot: async (request) => ({
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      syncRunId: "sync-fixture-1",
      brokerId: descriptor.brokerId,
      account: {
        brokerId: descriptor.brokerId,
        accountAlias: request.accountAlias,
        accountIdentityHash: "hash_fixture",
        baseCurrency: "TWD",
        marketScope: ["TWSE"],
        status: "active",
        createdAt: request.requestedAt,
        updatedAt: request.requestedAt
      },
      sourceType: "live-api",
      sourceFreshness: {
        sourceType: "live-api",
        sourceName: descriptor.adapterId,
        sourceTimestamp: "2026-06-05T01:00:00.000Z",
        fetchedAt: request.requestedAt,
        maxAgeMinutes: 1440,
        status: "fresh",
        missingFields: []
      },
      baseCurrency: "TWD",
      asOf: "2026-06-05T01:00:00.000Z",
      holdings: [],
      cashBalances: [],
      activityRows: [],
      errors: [],
      dataQuality: []
    }),
    classifyError: classifyBrokerSyncError
  };

  assert.equal(connector.preflight({ accountAlias: "tw-main", mode: "dry-run", requestedAt: "2026-06-05T02:00:00.000Z" }).ok, true);

  const snapshot = await connector.syncSnapshot({
    accountAlias: "tw-main",
    mode: "dry-run",
    requestedAt: "2026-06-05T02:00:00.000Z"
  });

  assert.equal(snapshot.schemaVersion, SNAPSHOT_SCHEMA_VERSION);
  assert.equal(snapshot.sourceFreshness.sourceTimestamp, "2026-06-05T01:00:00.000Z");
});

test("importer interface supports preview and approved file commit", async () => {
  const descriptor = baseDescriptor({
    adapterId: "fixture-csv",
    kind: "csv-importer",
    supportedSourceTypes: ["csv-current-position-snapshot"],
    credentialMode: "owner-upload",
    productionStatus: "import-only"
  });
  const importer = {
    describe: () => descriptor,
    preflight: () => validateReadOnlyDescriptor(descriptor),
    previewImport: async (request) => ({
      accountAlias: request.accountAlias,
      sourceType: request.sourceType,
      sourceTimestamp: "2026-06-05T01:00:00.000Z",
      checksum: request.checksum,
      status: "accepted",
      missingFields: [],
      rowCounts: { accounts: 1, holdings: 1, cashBalances: 0, activityRows: 0, skippedRows: 0, errors: 0 }
    }),
    commitImport: async (request) => {
      assert.equal(request.ownerApproved, true);
      return {
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        syncRunId: "import-fixture-1",
        brokerId: descriptor.brokerId,
        account: {
          brokerId: descriptor.brokerId,
          accountAlias: request.accountAlias,
          accountIdentityHash: "hash_fixture",
          baseCurrency: "USD",
          marketScope: ["NASDAQ"],
          status: "active",
          createdAt: request.requestedAt,
          updatedAt: request.requestedAt
        },
        sourceType: request.sourceType,
        sourceFreshness: {
          sourceType: request.sourceType,
          sourceName: descriptor.adapterId,
          sourceTimestamp: "2026-06-05T01:00:00.000Z",
          fetchedAt: request.requestedAt,
          committedAt: request.requestedAt,
          maxAgeMinutes: 1440,
          status: "fresh",
          missingFields: []
        },
        baseCurrency: "USD",
        asOf: "2026-06-05T01:00:00.000Z",
        holdings: [],
        cashBalances: [],
        activityRows: [],
        errors: [],
        dataQuality: []
      };
    },
    classifyError: classifyBrokerSyncError
  };

  const request = {
    accountAlias: "us-main",
    mode: "csv-import",
    sourceType: "csv-current-position-snapshot",
    filePath: "/private/imports/firstrade.csv",
    requestedAt: "2026-06-05T02:00:00.000Z",
    checksum: "sha256:fixture",
    ownerApproved: true
  };

  const preview = await importer.previewImport(request);
  const snapshot = await importer.commitImport(request);

  assert.equal(preview.status, "accepted");
  assert.equal(snapshot.sourceType, "csv-current-position-snapshot");
  assert.equal(snapshot.sourceFreshness.committedAt, request.requestedAt);
});

test("registry selects adapters by broker and source type", () => {
  const connector = {
    describe: () =>
      baseDescriptor({
        adapterId: "sinopac-shioaji",
        brokerId: "sinopac",
        supportedSourceTypes: ["live-api"],
        credentialMode: "read-only-secret"
      }),
    preflight: () => ({ ok: true, status: "succeeded" }),
    syncSnapshot: async () => {
      throw new Error("not needed");
    },
    classifyError: classifyBrokerSyncError
  };
  const importer = {
    describe: () =>
      baseDescriptor({
        adapterId: "firstrade-csv",
        brokerId: "firstrade",
        kind: "csv-importer",
        supportedSourceTypes: ["csv-current-position-snapshot"],
        credentialMode: "owner-upload",
        productionStatus: "import-only"
      }),
    preflight: () => ({ ok: true, status: "succeeded" }),
    previewImport: async () => {
      throw new Error("not needed");
    },
    commitImport: async () => {
      throw new Error("not needed");
    },
    classifyError: classifyBrokerSyncError
  };
  const registry = new BrokerAdapterRegistry();

  assert.equal(registry.registerConnector(connector).ok, true);
  assert.equal(registry.registerImporter(importer).ok, true);

  assert.equal(registry.select({ brokerId: "sinopac", sourceType: "live-api", role: "connector" }).connector, connector);
  assert.equal(registry.select({ brokerId: "firstrade", sourceType: "csv-current-position-snapshot", role: "importer" }).importer, importer);
  assert.equal(registry.select({ brokerId: "firstrade", sourceType: "live-api" }), undefined);
});

test("registry rejects unsafe or duplicate adapters", () => {
  const registry = new BrokerAdapterRegistry();
  const connector = {
    describe: () => baseDescriptor({ adapterId: "duplicate" }),
    preflight: () => ({ ok: true, status: "succeeded" }),
    syncSnapshot: async () => {
      throw new Error("not needed");
    },
    classifyError: classifyBrokerSyncError
  };
  const unsafe = {
    ...connector,
    describe: () => baseDescriptor({ adapterId: "unsafe", credentialMode: "browser-session" })
  };

  assert.equal(registry.registerConnector(connector).ok, true);

  const duplicate = registry.registerConnector(connector);
  const unsafeResult = registry.registerConnector(unsafe);

  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.errorClass, "schema-mismatch");
  assert.equal(unsafeResult.ok, false);
  assert.equal(unsafeResult.errorClass, "unsafe-input");
});

test("fixture connector returns holdings and cash without credentials", async () => {
  const connector = createFixtureBrokerConnector({ scenario: "complete", sourceTimestamp: "2026-06-05T01:00:00.000Z" });
  const descriptor = connector.describe();

  assert.equal(descriptor.credentialMode, "none");
  assert.equal(descriptor.productionStatus, "fixture-only");

  const snapshot = await connector.syncSnapshot({
    accountAlias: "fixture-main",
    mode: "fixture",
    requestedAt: "2026-06-05T02:00:00.000Z"
  });

  assert.equal(snapshot.sourceFreshness.status, "fresh");
  assert.equal(snapshot.holdings.length, 1);
  assert.equal(snapshot.cashBalances.length, 1);
  assert.equal(snapshot.errors.length, 0);
});

test("fixture connector marks partial data without fabricating missing fields", async () => {
  const connector = createFixtureBrokerConnector({ scenario: "partial" });
  const snapshot = await connector.syncSnapshot({
    accountAlias: "fixture-partial",
    mode: "fixture",
    requestedAt: "2026-06-05T02:00:00.000Z"
  });

  assert.equal(snapshot.sourceFreshness.status, "partial");
  assert.equal(snapshot.holdings.length, 1);
  assert.equal(snapshot.holdings[0].costBasis, undefined);
  assert.equal(snapshot.cashBalances.length, 0);
  assert.deepEqual(snapshot.sourceFreshness.missingFields, ["cashBalances", "holdings.costBasis"]);
});

test("fixture connector marks stale snapshots when source timestamp exceeds freshness window", async () => {
  const connector = createFixtureBrokerConnector({
    scenario: "complete",
    sourceTimestamp: "2026-06-03T00:00:00.000Z"
  });
  const snapshot = await connector.syncSnapshot({
    accountAlias: "fixture-stale",
    mode: "fixture",
    requestedAt: "2026-06-05T02:00:00.000Z"
  });

  assert.equal(snapshot.sourceFreshness.status, "stale");
  assert.equal(snapshot.sourceFreshness.maxAgeMinutes, 1440);
  assert.equal(snapshot.sourceFreshness.sourceTimestamp, "2026-06-03T00:00:00.000Z");
});

test("fixture connector can emit failed sync state", async () => {
  const connector = createFixtureBrokerConnector({ scenario: "failed" });
  const snapshot = await connector.syncSnapshot({
    accountAlias: "fixture-failed",
    mode: "fixture",
    requestedAt: "2026-06-05T02:00:00.000Z"
  });

  assert.equal(snapshot.sourceFreshness.status, "failed");
  assert.equal(snapshot.holdings.length, 0);
  assert.equal(snapshot.cashBalances.length, 0);
  assert.equal(snapshot.errors[0].errorClass, "auth-failed");
});

test("missing credentials are classified before any sync snapshot is produced", () => {
  const missingCredentialError = classifyBrokerSyncError(new Error("missing broker credentials"));

  assert.equal(missingCredentialError, "missing-credentials");
});

test("fixture connector refuses non-fixture mode", () => {
  const connector = createFixtureBrokerConnector();
  const preflight = connector.preflight({
    accountAlias: "fixture-main",
    mode: "dry-run",
    requestedAt: "2026-06-05T02:00:00.000Z"
  });

  assert.equal(preflight.ok, false);
  assert.equal(preflight.status, "rejected");
  assert.equal(preflight.errorClass, "unsafe-input");
});
