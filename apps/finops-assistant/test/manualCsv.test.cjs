const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createManualCsvImporter } = require("../dist/manualCsv.js");

function writeImportFile(contents) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "manual-csv-"));
  const filePath = path.join(directory, "manual.csv");
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
  return createManualCsvImporter({
    importHistoryStore: createImportHistoryStore(),
    ...overrides
  });
}

function baseRequest(filePath, overrides = {}) {
  return {
    accountAlias: "manual-main",
    mode: "manual-import",
    sourceType: "manual-csv",
    filePath,
    requestedAt: "2026-06-05T02:00:00.000Z",
    ownerApproved: true,
    ...overrides
  };
}

test("manual importer parses holding rows from owner-provided file", async () => {
  const filePath = writeImportFile([
    "row-type,market,symbol,quantity,average-cost,cost-basis,currency,market-value,as-of",
    "holding,NASDAQ,AAPL,10,150.00,1500.00,USD,1510.00,2026-06-05T01:00:00.000Z"
  ].join("\n"));
  const importer = createImporter();

  const snapshot = await importer.commitImport(baseRequest(filePath));

  assert.equal(snapshot.holdings.length, 1);
  assert.equal(snapshot.holdings[0].symbol, "AAPL");
  assert.equal(snapshot.sourceFreshness.status, "fresh");
});

test("manual importer parses cash and activity rows", async () => {
  const filePath = writeImportFile([
    "row-type,action,symbol,amount,currency,as-of,description",
    "cash, , ,1234.56,USD,2026-06-05T01:00:00.000Z,initial cash",
    "activity,buy,AAPL,1200,USD,2026-06-05T01:00:00.000Z,acquired"
  ].join("\n"));
  const importer = createImporter();

  const snapshot = await importer.commitImport(baseRequest(filePath));

  assert.equal(snapshot.cashBalances.length, 1);
  assert.equal(snapshot.activityRows.length, 1);
  assert.equal(snapshot.activityRows[0].activityType, "buy");
});

test("manual importer rejects non-manual mode", async () => {
  const filePath = writeImportFile("row-type,market,symbol,quantity\nholding,NASDAQ,AAPL,10");
  const importer = createImporter();

  const result = importer.preflight(baseRequest(filePath, { mode: "csv-import" }));
  assert.equal(result.ok, false);
  assert.equal(result.errorClass, "unsafe-input");
});

test("manual importer requires owner approval before commit", async () => {
  const filePath = writeImportFile("row-type,market,symbol,quantity\nholding,NASDAQ,AAPL,10");
  const importer = createImporter();

  assert.throws(() => importer.commitImport(baseRequest(filePath, { ownerApproved: false })), /owner approval/);
});

test("Manual CSV preflight rejects unsafe account aliases", () => {
  const filePath = writeImportFile("row-type,market,symbol,quantity\nholding,NASDAQ,AAPL,10");
  const importer = createImporter();
  const result = importer.preflight(baseRequest(filePath, { accountAlias: "user space" }));

  assert.equal(result.ok, false);
  assert.equal(result.errorClass, "unsafe-input");
});

test("Manual CSV preflight rejects unsupported delimiter", () => {
  const filePath = writeImportFile("row-type;market;symbol;quantity\nholding;NASDAQ;AAPL;10");
  const importer = createImporter();
  const result = importer.preflight(baseRequest(filePath));

  assert.equal(result.ok, false);
  assert.equal(result.errorClass, "schema-mismatch");
});

test("Manual CSV importer idempotency uses same snapshot for duplicated checksum", async () => {
  const filePath = writeImportFile("row-type,market,symbol,quantity,average-cost,cost-basis,currency,market-value,as-of\nholding,NASDAQ,AAPL,10,150.00,1500.00,USD,1510.00,2026-06-05T01:00:00.000Z");
  const store = createImportHistoryStore();
  const importer = createImporter({ importHistoryStore: store, retainRawImport: true });
  const request = baseRequest(filePath, { retainRawImport: true });

  const first = await importer.commitImport(request);
  const second = await importer.commitImport(request);

  assert.equal(first, second);
  assert.equal(first.holdings.length, 1);
});

test("Manual CSV importer keeps raw file when retention is enabled", async () => {
  const filePath = writeImportFile("row-type,market,symbol,quantity,average-cost,cost-basis,currency,market-value,as-of\nholding,NASDAQ,AAPL,10,150.00,1500.00,USD,1510.00,2026-06-05T01:00:00.000Z");
  const importer = createImporter({ retainRawImport: true });

  await importer.commitImport(baseRequest(filePath));
  assert.equal(fs.existsSync(filePath), true);
});

test("Manual CSV importer sanitizes formula-like text input", async () => {
  const filePath = writeImportFile(
    "row-type,action,symbol,amount,currency,as-of,description\nactivity,buy,AAPL,1200,USD,2026-06-05T01:00:00.000Z,=cmd('rm -rf /')"
  );
  const importer = createImporter();

  const snapshot = await importer.commitImport(baseRequest(filePath));

  assert.equal(snapshot.activityRows[0].sourceDescription, "'=cmd('rm -rf /')");
});

test("Manual CSV importer rejects stale source rows", () => {
  const filePath = writeImportFile("row-type,market,symbol,quantity,average-cost,cost-basis,currency,market-value,as-of\nholding,NASDAQ,AAPL,10,150.00,1500.00,USD,1510.00,2010-01-01T01:00:00.000Z");
  const importer = createImporter();

  const result = importer.preflight(baseRequest(filePath));
  assert.equal(result.ok, false);
  assert.equal(result.errorClass, "schema-mismatch");
  assert.match(result.reason, /Date is stale/);
});

test("Manual CSV preview throws when stale rows are detected", () => {
  const filePath = writeImportFile("row-type,market,symbol,quantity,average-cost,cost-basis,currency,market-value,as-of\nholding,NASDAQ,AAPL,10,150.00,1500.00,USD,1510.00,2010-01-01T01:00:00.000Z");
  const importer = createImporter();

  assert.throws(() => importer.previewImport(baseRequest(filePath)), /Invalid manual import request/);
});
