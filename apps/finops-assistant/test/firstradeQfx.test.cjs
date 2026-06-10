const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createFirstradeQfxImporter } = require("../dist/firstradeQfx.js");

function writeImportFile(contents) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "firstrade-qfx-"));
  const filePath = path.join(directory, "firstrade.qfx");
  fs.writeFileSync(filePath, contents, "utf8");
  return filePath;
}

function baseRequest(filePath, overrides = {}) {
  return {
    accountAlias: "firstrade-main",
    mode: "csv-import",
    sourceType: "statement-import",
    filePath,
    requestedAt: "2026-06-08T08:00:00.000Z",
    ownerApproved: true,
    ...overrides
  };
}

const qfxFixture = [
  "OFXHEADER:100",
  "DATA:OFXSGML",
  "VERSION:102",
  "",
  "<OFX><INVSTMTMSGSRSV1><INVSTMTTRNRS><INVSTMTRS>",
  "<DTASOF>20260605000000</DTASOF><CURDEF>USD</CURDEF>",
  "<INVTRANLIST><DTSTART>20260401000000</DTSTART><DTEND>20260608000000</DTEND>",
  "<BUYSTOCK><INVBUY><INVTRAN><FITID>P05424420260508K5289D</FITID><DTTRADE>20260507</DTTRADE><DTSETTLE>20260508</DTSETTLE><MEMO>PALANTIR TECHNOLOGIES INC</MEMO></INVTRAN><SECID><UNIQUEID>P054244</UNIQUEID><UNIQUEIDTYPE>CUSIP</UNIQUEIDTYPE></SECID><UNITS>10.00000</UNITS><UNITPRICE>135.01000000</UNITPRICE><TOTAL>-1350.1</TOTAL></INVBUY><BUYTYPE>BUY</BUYTYPE></BUYSTOCK>",
  "<INVBANKTRAN><STMTTRN><TRNTYPE>CREDIT</TRNTYPE><DTPOSTED>20260413</DTPOSTED><TRNAMT>3120.34</TRNAMT><FITID>529758989</FITID><NAME>Wire Funds Received</NAME></STMTTRN></INVBANKTRAN>",
  "</INVTRANLIST>",
  "<INVPOSLIST>",
  "<POSSTOCK><INVPOS><SECID><UNIQUEID>C078361</UNIQUEID><UNIQUEIDTYPE>CUSIP</UNIQUEIDTYPE></SECID><HELDINACCT>CASH</HELDINACCT><POSTYPE>LONG</POSTYPE><UNITS>6.00000</UNITS><UNITPRICE>250.11</UNITPRICE><MKTVAL>1500.66</MKTVAL><DTPRICEASOF>19900101</DTPRICEASOF><MEMO>CLOUDFLARE INC</MEMO></INVPOS></POSSTOCK>",
  "<POSSTOCK><INVPOS><SECID><UNIQUEID>N003056</UNIQUEID><UNIQUEIDTYPE>CUSIP</UNIQUEIDTYPE></SECID><HELDINACCT>CASH</HELDINACCT><POSTYPE>LONG</POSTYPE><UNITS>2.00000</UNITS><UNITPRICE>205.1</UNITPRICE><MKTVAL>410.20</MKTVAL><DTPRICEASOF>19900101</DTPRICEASOF><MEMO>NVIDIA CORP</MEMO></INVPOS></POSSTOCK>",
  "</INVPOSLIST>",
  "<INVBAL><AVAILCASH>179.73</AVAILCASH></INVBAL>",
  "</INVSTMTRS></INVSTMTTRNRS></INVSTMTMSGSRSV1>",
  "<SECLISTMSGSRSV1><SECLIST>",
  "<STOCKINFO><SECINFO><SECID><UNIQUEID>C078361</UNIQUEID><UNIQUEIDTYPE>CUSIP</UNIQUEIDTYPE></SECID><SECNAME>CLOUDFLARE INC                 C078361</SECNAME><TICKER>NET</TICKER></SECINFO></STOCKINFO>",
  "<STOCKINFO><SECINFO><SECID><UNIQUEID>N003056</UNIQUEID><UNIQUEIDTYPE>CUSIP</UNIQUEIDTYPE></SECID><SECNAME>NVIDIA CORP                    N003056</SECNAME><TICKER>NVDA</TICKER></SECINFO></STOCKINFO>",
  "<STOCKINFO><SECINFO><SECID><UNIQUEID>P054244</UNIQUEID><UNIQUEIDTYPE>CUSIP</UNIQUEIDTYPE></SECID><SECNAME>PALANTIR TECHNOLOGIES INC      P054244</SECNAME><TICKER>PLTR</TICKER></SECINFO></STOCKINFO>",
  "</SECLIST></SECLISTMSGSRSV1></OFX>"
].join("\n");

test("Firstrade QFX importer previews and commits holdings, cash, and activity", async () => {
  const filePath = writeImportFile(qfxFixture);
  const importer = createFirstradeQfxImporter({ retainRawImport: true });

  const preflight = importer.preflight(baseRequest(filePath));
  const preview = await importer.previewImport(baseRequest(filePath));
  const snapshot = await importer.commitImport(baseRequest(filePath));

  assert.equal(preflight.ok, true);
  assert.equal(preview.status, "partial");
  assert.equal(preview.rowCounts.holdings, 2);
  assert.equal(preview.rowCounts.cashBalances, 1);
  assert.equal(preview.rowCounts.activityRows, 2);
  assert.equal(snapshot.sourceFreshness.sourceName, "firstrade-qfx");
  assert.equal(snapshot.sourceFreshness.status, "partial");
  assert.equal(snapshot.asOf, "2026-06-05T00:00:00.000Z");
  assert.equal(snapshot.holdings[0].symbol, "NET");
  assert.equal(snapshot.holdings[0].providerSymbol, "C078361");
  assert.equal(snapshot.holdings[0].securityName, "CLOUDFLARE INC");
  assert.equal(snapshot.holdings[0].quantity, "6.00000");
  assert.equal(snapshot.holdings[0].lastPrice, "250.11");
  assert.equal(snapshot.holdings[0].marketValue, "1500.66");
  assert.deepEqual(snapshot.holdings[0].dataQuality, ["holdings.averageCost", "holdings.costBasis"]);
  assert.equal(snapshot.cashBalances[0].amount, "179.73");
  assert.equal(snapshot.activityRows[0].symbol, "PLTR");
  assert.equal(snapshot.activityRows[1].activityType, "deposit");
});

test("Firstrade QFX importer rejects non-QFX source types", () => {
  const filePath = writeImportFile(qfxFixture);
  const importer = createFirstradeQfxImporter();
  const result = importer.preflight(baseRequest(filePath, { sourceType: "transaction-history" }));

  assert.equal(result.ok, false);
  assert.equal(result.errorClass, "schema-mismatch");
});
