const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createFirstradeCsvImporter } = require("../dist/firstradeCsv.js");

function writeImportFile(contents) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "firstrade-csv-"));
  const filePath = path.join(directory, "firstrade-export.csv");
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
  return createFirstradeCsvImporter({
    importHistoryStore: createImportHistoryStore(),
    ...overrides
  });
}

function baseRequest(filePath, overrides = {}) {
  return {
    accountAlias: "firstrade-main",
    mode: "csv-import",
    sourceType: "csv-current-position-snapshot",
    filePath,
    requestedAt: "2026-06-05T02:00:00.000Z",
    ownerApproved: true,
    ...overrides
  };
}

test("Firstrade CSV position importer previews and commits current-position snapshot", async () => {
  const filePath = writeImportFile([
    "as-of,market,symbol,quantity,averageCost,costBasis,lastPrice,marketValue,currency,name",
    "2026-06-05T01:00:00.000Z,NYSE,AAPL,15,170.00,2550.00,175.50,2632.50,USD,Apple Inc"
  ].join("\n"));
  const importer = createImporter();

  const preview = await importer.previewImport(baseRequest(filePath));
  const snapshot = await importer.commitImport(baseRequest(filePath));

  assert.equal(preview.status, "accepted");
  assert.equal(snapshot.sourceType, "csv-current-position-snapshot");
  assert.equal(snapshot.holdings[0].symbol, "AAPL");
  assert.equal(snapshot.holdings[0].quantity, "15");
  assert.equal(snapshot.sourceFreshness.status, "fresh");
});

test("Firstrade CSV cash importer parses cash balances", async () => {
  const filePath = writeImportFile([
    "as-of,currency,amount,type",
    "2026-06-05T01:00:00.000Z,USD,1234.56,settled"
  ].join("\n"));
  const importer = createImporter();

  const snapshot = await importer.commitImport(
    baseRequest(filePath, {
      sourceType: "csv-cash-snapshot"
    })
  );

  assert.equal(snapshot.sourceType, "csv-cash-snapshot");
  assert.equal(snapshot.cashBalances.length, 1);
  assert.equal(snapshot.cashBalances[0].amount, "1234.56");
  assert.equal(snapshot.cashBalances[0].balanceType, "settled");
  assert.equal(snapshot.sourceFreshness.status, "fresh");
});

test("Firstrade CSV transaction-history importer maps activity rows", async () => {
  const filePath = writeImportFile([
    "trade-date,action,symbol,quantity,amount,currency",
    "2026-05-31,buy,AAPL,10,2000,USD",
    "2026-05-31,sell,MSFT,5,3500,USD"
  ].join("\n"));
  const importer = createImporter();

  const preview = await importer.previewImport(
    baseRequest(filePath, {
      sourceType: "transaction-history"
    })
  );
  const snapshot = await importer.commitImport(
    baseRequest(filePath, {
      sourceType: "transaction-history"
    })
  );

  assert.equal(preview.status, "partial");
  assert.equal(snapshot.sourceType, "transaction-history");
  assert.equal(snapshot.activityRows.length, 2);
  assert.equal(snapshot.activityRows[0].activityType, "buy");
  assert.equal(snapshot.sourceFreshness.status, "partial");
});

test("Firstrade CSV gain-loss importer requires owner approval before commit", async () => {
  const filePath = writeImportFile([
    "trade-date,action,symbol,amount,currency",
    "2026-06-01,gain-loss,AAPL,120.00,USD"
  ].join("\n"));
  const importer = createImporter();

  assert.throws(() => importer.commitImport(
    baseRequest(filePath, {
      sourceType: "prior-year-gain-loss",
      ownerApproved: false
    })
  ), /owner approval/);
});

test("Firstrade CSV preflight rejects non-csv files", async () => {
  const importer = createImporter();
  const badPath = writeImportFile("trade-date,action,symbol,amount,currency\n2026-06-05,buy,AAPL,100,USD").replace("firstrade-export.csv", "firstrade-export.txt");
  const result = importer.preflight(baseRequest(badPath));

  assert.equal(result.ok, false);
  assert.equal(result.errorClass, "schema-mismatch");
});

test("Firstrade CSV preflight rejects missing required headers", () => {
  const importer = createImporter();
  const badPath = writeImportFile("trade-date,action,currency\n2026-06-05,buy,AAPL,USD");
  const result = importer.preflight(
    baseRequest(badPath, {
      sourceType: "transaction-history"
    })
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorClass, "schema-mismatch");
});

test("Firstrade CSV preflight rejects invalid numeric values", () => {
  const importer = createImporter();
  const badPath = writeImportFile([
    "as-of,market,symbol,quantity,averageCost,costBasis,lastPrice,marketValue,currency,name",
    "2026-06-05T01:00:00.000Z,NYSE,AAPL,not-a-number,170.00,2550.00,175.50,2632.50,USD,Apple"
  ].join("\n"));
  const result = importer.preflight(baseRequest(badPath));

  assert.equal(result.ok, false);
  assert.equal(result.errorClass, "schema-mismatch");
});

test("Firstrade CSV preview rejects malformed content before commit", async () => {
  const importer = createImporter();
  const badPath = writeImportFile("bad-header\nAAPL,10,1200");

  assert.throws(() => {
    importer.previewImport(baseRequest(badPath, { sourceType: "transaction-history" }));
  }, /Invalid Firstrade import request/);
});

test("Firstrade CSV importer enforces row count limits in preflight", () => {
  const importer = createImporter();
  const rows = Array.from({ length: 5001 }, (_, index) => `2026-06-05T01:00:00.000Z,NYSE,AAPL,${index + 1},170,1700,175.5,3000,USD,Apple`);
  const badPath = writeImportFile(["as-of,market,symbol,quantity,averageCost,costBasis,lastPrice,marketValue,currency,name", ...rows].join("\n"));
  const result = importer.preflight(baseRequest(badPath));

  assert.equal(result.ok, false);
  assert.equal(result.errorClass, "unsafe-input");
  assert.match(result.reason, /row limit/);
});

test("Firstrade CSV importer sanitizes formula-like text fields", async () => {
  const filePath = writeImportFile([
    "trade-date,action,symbol,amount,currency,description",
    "2026-06-05,activity,AAPL,1200,USD,=cmd('rm -rf /')"
  ].join("\n"));
  const importer = createImporter();
  const snapshot = await importer.commitImport(baseRequest(filePath, { sourceType: "transaction-history" }));

  assert.equal(snapshot.activityRows[0].sourceDescription, "'=cmd('rm -rf /')");
});

test("Firstrade CSV importer deletes raw import file by default after commit", async () => {
  const filePath = writeImportFile([
    "as-of,market,symbol,quantity,averageCost,costBasis,lastPrice,marketValue,currency,name",
    "2026-06-05T01:00:00.000Z,NYSE,AAPL,15,170.00,2550.00,175.50,2632.50,USD,Apple"
  ].join("\n"));
  const importer = createImporter();

  await importer.commitImport(baseRequest(filePath));
  assert.equal(fs.existsSync(filePath), false);
});

test("Firstrade CSV importer is idempotent for duplicate imports", async () => {
  const filePath = writeImportFile([
    "as-of,market,symbol,quantity,averageCost,costBasis,lastPrice,marketValue,currency,name",
    "2026-06-05T01:00:00.000Z,NYSE,AAPL,15,170.00,2550.00,175.50,2632.50,USD,Apple"
  ].join("\n"));
  const historyStore = createImportHistoryStore();
  const importer = createImporter({ importHistoryStore: historyStore, retainRawImport: true });
  const request = baseRequest(filePath, { retainRawImport: true });

  const first = await importer.commitImport(request);
  const second = await importer.commitImport(request);

  assert.equal(first, second);
  assert.equal(first.holdings.length, 1);
  assert.equal(fs.existsSync(filePath), true);
});

test("Firstrade CSV importer rejects stale source rows in preview", () => {
  const filePath = writeImportFile([
    "as-of,market,symbol,quantity,averageCost,costBasis,lastPrice,marketValue,currency,name",
    "2015-01-01T01:00:00.000Z,NYSE,AAPL,15,170.00,2550.00,175.50,2632.50,USD,Apple"
  ].join("\n"));
  const importer = createImporter();
  const result = importer.preflight(
    baseRequest(filePath, {
      sourceType: "csv-current-position-snapshot"
    })
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorClass, "schema-mismatch");
  assert.match(result.reason, /Date is stale/);
});
