const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createSinoPacCsvImporter } = require("../dist/sinopacCsv.js");

function writeImportFile(contents) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sinopac-csv-"));
  const filePath = path.join(directory, "positions.csv");
  fs.writeFileSync(filePath, contents, "utf8");
  return filePath;
}

function createImportHistoryStore() {
  const items = new Map();
  return {
    get(checksum) {
      return items.get(checksum);
    },
    set(checksum, snapshot) {
      items.set(checksum, snapshot);
    }
  };
}

function createImporter(overrides = {}) {
  return createSinoPacCsvImporter({
    importHistoryStore: createImportHistoryStore(),
    ...overrides
  });
}

function baseRequest(filePath, overrides = {}) {
  return {
    accountAlias: "sinopac-main",
    mode: "csv-import",
    sourceType: "csv-current-position-snapshot",
    filePath,
    requestedAt: "2026-06-05T02:00:00.000Z",
    ownerApproved: true,
    ...overrides
  };
}

test("SinoPac CSV importer previews position and cash rows", async () => {
  const filePath = writeImportFile(
    [
      "type,asOf,market,symbol,name,quantity,averageCost,costBasis,lastPrice,marketValue,unrealizedPnl,unrealizedPnlPercent,currency,amount,balanceType",
      "position,2026-06-05T01:00:00.000Z,TWSE,2330,TSMC,10,700.00,7000.00,850.00,8500.00,1500.00,21.43,TWD,,",
      "cash,2026-06-05T01:00:00.000Z,,,,,,,,,,,TWD,12345.00,settled"
    ].join("\n")
  );
  const importer = createImporter();

  const preview = await importer.previewImport(baseRequest(filePath));

  assert.equal(preview.status, "accepted");
  assert.equal(preview.rowCounts.holdings, 1);
  assert.equal(preview.rowCounts.cashBalances, 1);
  assert.equal(preview.sourceTimestamp, "2026-06-05T01:00:00.000Z");
});

test("SinoPac CSV importer commits approved position and cash snapshot", async () => {
  const filePath = writeImportFile(
    [
      "type,asOf,market,symbol,name,quantity,averageCost,costBasis,lastPrice,marketValue,unrealizedPnl,unrealizedPnlPercent,currency,amount,balanceType",
      "position,2026-06-05T01:00:00.000Z,TPEx,6488,GlobalWafers,3,400.00,1200.00,500.00,1500.00,300.00,25.00,TWD,,",
      "cash,2026-06-05T01:00:00.000Z,,,,,,,,,,,TWD,5000.00,available"
    ].join("\n")
  );
  const importer = createImporter();

  const snapshot = await importer.commitImport(baseRequest(filePath));

  assert.equal(snapshot.sourceType, "csv-current-position-snapshot");
  assert.equal(snapshot.sourceFreshness.status, "fresh");
  assert.equal(snapshot.holdings[0].symbol, "6488");
  assert.equal(snapshot.holdings[0].market, "TPEx");
  assert.equal(snapshot.cashBalances[0].amount, "5000.00");
  assert.equal(snapshot.cashBalances[0].balanceType, "available");
});

test("SinoPac CSV importer requires owner approval before commit", async () => {
  const filePath = writeImportFile("type,asOf,market,symbol,quantity,currency\nposition,2026-06-05T01:00:00.000Z,TWSE,2330,10,TWD");
  const importer = createImporter();

  assert.throws(() => importer.commitImport(baseRequest(filePath, { ownerApproved: false })), /owner approval/);
});

test("SinoPac CSV importer marks missing valuation fields as partial", async () => {
  const filePath = writeImportFile("type,asOf,market,symbol,quantity,currency\nposition,2026-06-05T01:00:00.000Z,TWSE,2330,10,TWD");
  const importer = createImporter();

  const preview = await importer.previewImport(baseRequest(filePath));
  const snapshot = await importer.commitImport(baseRequest(filePath));

  assert.equal(preview.status, "partial");
  assert.equal(snapshot.sourceFreshness.status, "partial");
  assert.deepEqual(snapshot.sourceFreshness.missingFields, [
    "holdings.averageCost",
    "holdings.costBasis",
    "holdings.marketValue"
  ]);
});

test("SinoPac CSV preflight rejects non-csv files", async () => {
  const importer = createImporter();
  const badPath = writeImportFile("type,asOf,market,symbol,quantity\nposition,2026-06-05T01:00:00.000Z,TWSE,2330,10").replace("positions.csv", "positions.txt");

  const result = importer.preflight({
    ...baseRequest(badPath),
    filePath: badPath
  });

  assert.equal(result.ok, false);
  assert.equal(result.errorClass, "schema-mismatch");
});

test("SinoPac CSV preflight rejects missing required headers", async () => {
  const badPath = writeImportFile("asOf,market,symbol,quantity\nposition,2026-06-05T01:00:00.000Z,TWSE,2330,10");
  const importer = createImporter();

  const result = importer.preflight(baseRequest(badPath));

  assert.equal(result.ok, false);
  assert.equal(result.errorClass, "schema-mismatch");
});

test("SinoPac CSV preflight rejects invalid symbol format", async () => {
  const badPath = writeImportFile("type,asOf,market,symbol,quantity\nposition,2026-06-05T01:00:00.000Z,TWSE,AAPL$,10");
  const importer = createImporter();

  const result = importer.preflight(baseRequest(badPath));

  assert.equal(result.ok, false);
  assert.equal(result.errorClass, "schema-mismatch");
});

test("SinoPac CSV importer is idempotent for duplicate content", async () => {
  const filePath = writeImportFile([
    "type,asOf,market,symbol,name,quantity,averageCost,costBasis,lastPrice,marketValue,unrealizedPnl,unrealizedPnlPercent,currency,amount,balanceType",
    "position,2026-06-05T01:00:00.000Z,TWSE,2330,TSMC,10,700.00,7000.00,850.00,8500.00,1500.00,21.43,TWD,,",
    "cash,2026-06-05T01:00:00.000Z,,,,,,,,,,,TWD,12345.00,settled"
  ].join("\n"));
  const store = createImportHistoryStore();
  const importer = createSinoPacCsvImporter({ importHistoryStore: store, retainRawImport: true });
  const request = baseRequest(filePath, { retainRawImport: true });

  const first = await importer.commitImport(request);
  const second = await importer.commitImport(request);

  assert.equal(first, second);
  assert.equal(first.holdings[0].symbol, "2330");
});

test("SinoPac CSV import deletes raw file by default", async () => {
  const filePath = writeImportFile([
    "type,asOf,market,symbol,name,quantity,averageCost,costBasis,lastPrice,marketValue,unrealizedPnl,unrealizedPnlPercent,currency,amount,balanceType",
    "position,2026-06-05T01:00:00.000Z,TWSE,2330,TSMC,10,700.00,7000.00,850.00,8500.00,1500.00,21.43,TWD,,",
    "cash,2026-06-05T01:00:00.000Z,,,,,,,,,,,TWD,12345.00,settled"
  ].join("\n"));
  const importer = createImporter();

  await importer.commitImport(baseRequest(filePath));
  assert.equal(fs.existsSync(filePath), false);
});

test("SinoPac CSV importer sanitizes formula-like security-name input", async () => {
  const filePath = writeImportFile([
    "type,asOf,market,symbol,name,quantity,averageCost,costBasis,lastPrice,marketValue,unrealizedPnl,unrealizedPnlPercent,currency,amount,balanceType",
    "position,2026-06-05T01:00:00.000Z,TWSE,2330,=TSMC,10,700.00,7000.00,850.00,8500.00,1500.00,21.43,TWD,,"
  ].join("\n"));
  const importer = createImporter();

  const snapshot = await importer.commitImport(baseRequest(filePath));
  assert.equal(snapshot.holdings[0].securityName, "'=TSMC");
});
