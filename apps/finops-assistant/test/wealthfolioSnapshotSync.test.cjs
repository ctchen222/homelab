const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const { execFileSync } = require("node:child_process");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const {
  brokerDisplayName,
  buildWealthfolioProjection,
  marketMic,
  stableId
} = require("../scripts/wealthfolio_snapshot_sync.js");

function makeWealthfolioDb() {
  const dir = mkdtempSync(join(tmpdir(), "wf-snapshot-quotes-"));
  const dbPath = join(dir, "wealthfolio.db");
  execFileSync("sqlite3", [dbPath], {
    input: `
      CREATE TABLE quotes (
        id TEXT PRIMARY KEY,
        asset_id TEXT NOT NULL,
        day TEXT NOT NULL,
        source TEXT NOT NULL,
        open TEXT,
        high TEXT,
        low TEXT,
        close TEXT,
        adjclose TEXT,
        volume TEXT,
        currency TEXT,
        notes TEXT,
        created_at TEXT,
        timestamp TEXT,
        UNIQUE(asset_id, day, source)
      );
      CREATE TABLE daily_account_valuation (
        id TEXT PRIMARY KEY NOT NULL,
        account_id TEXT NOT NULL,
        valuation_date DATE NOT NULL,
        account_currency TEXT NOT NULL,
        base_currency TEXT NOT NULL,
        fx_rate_to_base TEXT NOT NULL,
        cash_balance TEXT NOT NULL,
        investment_market_value TEXT NOT NULL,
        total_value TEXT NOT NULL,
        cost_basis TEXT NOT NULL,
        net_contribution TEXT NOT NULL,
        cash_balance_base TEXT NOT NULL DEFAULT '0',
        investment_market_value_base TEXT NOT NULL DEFAULT '0',
        total_value_base TEXT NOT NULL DEFAULT '0',
        cost_basis_base TEXT NOT NULL DEFAULT '0',
        net_contribution_base TEXT NOT NULL DEFAULT '0',
        external_inflow_base TEXT NOT NULL DEFAULT '0',
        external_outflow_base TEXT NOT NULL DEFAULT '0',
        performance_eligible_value_base TEXT NOT NULL DEFAULT '0',
        calculated_at TEXT NOT NULL,
        external_flow_source TEXT NOT NULL DEFAULT 'UNKNOWN'
      );
    `,
    encoding: "utf8"
  });
  return { dir, dbPath };
}

function runQuery(dbPath, sql) {
  const raw = execFileSync("sqlite3", ["-json", dbPath, sql], { encoding: "utf8" }).trim();
  return raw ? JSON.parse(raw) : [];
}

test("Wealthfolio snapshot sync builds holdings-mode projection from normalized broker snapshot", () => {
  const now = new Date("2026-06-09T03:00:00.000Z");
  const snapshotAsOf = "2026-06-08T02:39:18.000Z";
  const asOfDate = "2026-06-08";
  const sinopacAssetId = stableId("finops-asset", ["sinopac", "TWSE", "2330"]);
  const brokerQuoteId = stableId("finops-quote", [sinopacAssetId, asOfDate, "FINOPS_BROKER"]);
  const projection = buildWealthfolioProjection(
    [
      {
        run: {
          sync_run_id: "sync-1",
          broker_id: "sinopac",
          account_alias: "sinopac-main",
          source_type: "live-api",
          source_name: "sinopac-shioaji",
          source_timestamp: "2026-06-08T02:39:18.000Z",
          freshness_status: "partial",
          missing_fields_json: "[\"holdings.marketValue\"]",
          base_currency: "TWD",
          as_of: snapshotAsOf,
          created_at: "2026-06-08T02:39:20.000Z"
        },
        holdings: [
          {
            market: "TWSE",
            symbol: "2330",
            provider_symbol: "2330",
            security_name: "TSMC",
            asset_type: "stock",
            currency: "TWD",
            quantity: "10",
            average_cost: "700",
            cost_basis: "7000",
            last_price: "850",
            market_value: "",
            as_of: "2026-06-08T02:39:18.000Z"
          },
          {
            market: "TWSE",
            symbol: "9999",
            provider_symbol: "9999",
            security_name: "Closed Holding",
            asset_type: "stock",
            currency: "TWD",
            quantity: "0",
            average_cost: "1",
            cost_basis: "0",
            last_price: "1",
            market_value: "",
            as_of: "2026-06-08T02:39:18.000Z"
          }
        ],
        cashBalances: [{ currency: "TWD", amount: "12345", balance_type: "available", as_of: "2026-06-08T02:39:18.000Z" }]
      }
    ],
    now
  );

  assert.equal(projection.summary.length, 1);
  assert.equal(projection.summary[0].positions, 1);
  assert.equal(projection.summary[0].cashCurrencies, 1);
  assert.equal(projection.summary[0].quotes, 1);
  assert.deepEqual(projection.summary[0].missingFields, ["holdings.marketValue"]);

  const sql = projection.statements.join("\n");
  assert.match(sql, /tracking_mode='HOLDINGS'/);
  assert.match(sql, /BROKER_IMPORTED/);
  assert.match(sql, /FINOPS_BROKER/);
  assert.match(sql, /FINOPS_COST_BASIS/);
  assert.match(sql, new RegExp(brokerQuoteId));
  assert.match(sql, /'850'/);
  assert.match(sql, /'19345'/);
  assert.match(sql, /'2026-06-08'/);
  assert.match(sql, /'MANUAL'/);
  assert.match(sql, /DELETE FROM quote_sync_state/);
  assert.match(sql, /DELETE FROM assets/);
  assert.match(sql, /id NOT IN/);
  assert.doesNotMatch(sql, /Closed Holding/);
  assert.doesNotMatch(sql, /FINOPS_MARKET/);
  assert.doesNotMatch(sql, /undefined/);
});

test("Wealthfolio snapshot sync upserts daily valuation from latest snapshot values", (t) => {
  const paths = makeWealthfolioDb();
  t.after(() => rmSync(paths.dir, { recursive: true, force: true }));
  const now = new Date("2026-07-07T05:50:01.507Z");
  const projection = buildWealthfolioProjection(
    [
      {
        run: {
          sync_run_id: "sync-valuation",
          broker_id: "sinopac",
          account_alias: "sinopac-main",
          source_type: "live-api",
          source_name: "sinopac-shioaji",
          source_timestamp: "2026-07-07T05:40:01.869Z",
          freshness_status: "partial",
          missing_fields_json: "[\"holdings.marketValue\"]",
          base_currency: "TWD",
          as_of: "2026-07-07T05:40:01.869Z",
          created_at: "2026-07-07T05:40:04.198Z"
        },
        holdings: [
          {
            market: "TWSE",
            symbol: "0050",
            provider_symbol: "0050",
            security_name: "Yuanta Taiwan 50",
            asset_type: "stock",
            currency: "TWD",
            quantity: "1319",
            average_cost: "64.07",
            cost_basis: "84508.33",
            last_price: "106.2",
            market_value: "",
            as_of: "2026-07-07T05:40:01.869Z"
          }
        ],
        cashBalances: [{ currency: "TWD", amount: "55156", balance_type: "available", as_of: "2026-07-07T05:40:01.869Z" }]
      }
    ],
    now
  );

  const valuationStatements = projection.statements.filter((statement) => statement.includes("daily_account_valuation")).join("\n");
  execFileSync("sqlite3", [paths.dbPath], { input: valuationStatements, encoding: "utf8" });

  const rows = runQuery(paths.dbPath, "SELECT valuation_date, cash_balance, investment_market_value, total_value, cost_basis, net_contribution, external_flow_source FROM daily_account_valuation;");
  assert.deepEqual(rows, [
    {
      valuation_date: "2026-07-07",
      cash_balance: "55156",
      investment_market_value: "140077.8",
      total_value: "195233.8",
      cost_basis: "84508.33",
      net_contribution: "139664.33",
      external_flow_source: "FINOPS_SNAPSHOT_SYNC"
    }
  ]);
});

test("SinoPac FINOPS_BROKER quote stays canonical when no FINOPS_MARKET rows are present", (t) => {
  const paths = makeWealthfolioDb();
  t.after(() => rmSync(paths.dir, { recursive: true, force: true }));
  const now = new Date("2026-06-10T03:00:00.000Z");
  const snapshotAsOf = "2026-06-10T02:39:18.000Z";
  const asOfDate = "2026-06-10";
  const sinopacAssetId = stableId("finops-asset", ["sinopac", "TWSE", "2330"]);
  const brokerQuoteId = stableId("finops-quote", [sinopacAssetId, asOfDate, "FINOPS_BROKER"]);
  const firstProjection = buildWealthfolioProjection(
    [
      {
        run: {
          sync_run_id: "sync-1",
          broker_id: "sinopac",
          account_alias: "sinopac-main",
          source_type: "live-api",
          source_name: "sinopac-shioaji",
          source_timestamp: snapshotAsOf,
          freshness_status: "partial",
          missing_fields_json: "[]",
          base_currency: "TWD",
          as_of: snapshotAsOf,
          created_at: now.toISOString()
        },
        holdings: [
          {
            market: "TWSE",
            symbol: "2330",
            provider_symbol: "2330",
            security_name: "TSMC",
            asset_type: "stock",
            currency: "TWD",
            quantity: "10",
            average_cost: "700",
            cost_basis: "7000",
            last_price: "880",
            market_value: "",
            as_of: snapshotAsOf
          }
        ],
        cashBalances: [{ currency: "TWD", amount: "1000", balance_type: "available", as_of: snapshotAsOf }]
      }
    ],
    now
  );
  const secondProjection = buildWealthfolioProjection(
    [
      {
        run: {
          sync_run_id: "sync-2",
          broker_id: "sinopac",
          account_alias: "sinopac-main",
          source_type: "live-api",
          source_name: "sinopac-shioaji",
          source_timestamp: "2026-06-10T03:00:00.000Z",
          freshness_status: "partial",
          missing_fields_json: "[]",
          base_currency: "TWD",
          as_of: "2026-06-10T03:00:00.000Z",
          created_at: "2026-06-10T03:00:30.000Z"
        },
        holdings: [
          {
            market: "TWSE",
            symbol: "2330",
            provider_symbol: "2330",
            security_name: "TSMC",
            asset_type: "stock",
            currency: "TWD",
            quantity: "10",
            average_cost: "700",
            cost_basis: "7000",
            last_price: "900",
            market_value: "",
            as_of: "2026-06-10T03:00:00.000Z"
          }
        ],
        cashBalances: [{ currency: "TWD", amount: "1000", balance_type: "available", as_of: "2026-06-10T03:00:00.000Z" }]
      }
    ],
    new Date("2026-06-10T03:01:00.000Z")
  );

  const quoteStatements = [
    ...firstProjection.statements.filter((statement) => statement.includes("INSERT INTO quotes")),
    ...secondProjection.statements.filter((statement) => statement.includes("INSERT INTO quotes"))
  ].join("\n");
  execFileSync("sqlite3", [paths.dbPath], { input: quoteStatements, encoding: "utf8" });

  const allRows = runQuery(
    paths.dbPath,
    `SELECT source, close FROM quotes WHERE asset_id = ${JSON.stringify(sinopacAssetId)} ORDER BY source;`
  );
  const brokerRows = runQuery(
    paths.dbPath,
    `SELECT source, close FROM quotes WHERE asset_id = ${JSON.stringify(sinopacAssetId)} AND source = 'FINOPS_BROKER';`
  );
  const marketRows = runQuery(
    paths.dbPath,
    `SELECT source, close FROM quotes WHERE asset_id = ${JSON.stringify(sinopacAssetId)} AND source = 'FINOPS_MARKET';`
  );

  assert.equal(allRows.length, 2);
  assert.equal(brokerRows.length, 1);
  assert.equal(marketRows.length, 0);
  assert.equal(brokerRows[0].source, "FINOPS_BROKER");
  assert.equal(brokerRows[0].close, "900");
  assert.match(firstProjection.statements.join("\n"), /ON CONFLICT\(asset_id, day, source\) DO UPDATE/);
  assert.match(secondProjection.statements.join("\n"), new RegExp(brokerQuoteId));
});

test("Wealthfolio sync helper maps common market codes to MICs and stable IDs", () => {
  assert.equal(marketMic("TWSE"), "XTAI");
  assert.equal(marketMic("TPEx"), "ROCO");
  assert.equal(marketMic("NASDAQ"), "XNAS");
  assert.equal(stableId("prefix", ["a", "b"]), stableId("prefix", ["a", "b"]));
});

test("Wealthfolio sync helper maps broker names for account labels", () => {
  const now = new Date("2026-06-08T03:00:00.000Z");
  const projection = buildWealthfolioProjection(
    [
      {
        run: {
          sync_run_id: "sync-2",
          broker_id: "firstrade",
          account_alias: "firstrade-main",
          source_type: "statement-import",
          source_name: "firstrade-qfx",
          source_timestamp: "2026-06-08T02:39:18.000Z",
          freshness_status: "partial",
          missing_fields_json: "[]",
          base_currency: "USD",
          as_of: "2026-06-08T02:39:18.000Z",
          created_at: "2026-06-08T02:39:20.000Z"
        },
        holdings: [
          {
            market: "US",
            symbol: "PLTR",
            provider_symbol: "P054244",
            security_name: "PALANTIR TECHNOLOGIES INC",
            asset_type: "stock",
            currency: "USD",
            quantity: "10",
            last_price: "135.53",
            market_value: "1355.30",
            as_of: "2026-06-05T00:00:00.000Z"
          }
        ],
        cashBalances: [{ currency: "USD", amount: "179.73", balance_type: "available", as_of: "2026-06-08T02:39:18.000Z" }],
        activityRows: [
          {
            activity_type: "buy",
            symbol: "PLTR",
            currency: "USD",
            quantity: "10",
            price: "135.01",
            amount: "-1350.1",
            amount_type: "net",
            trade_date: "2026-05-07T00:00:00.000Z"
          }
        ]
      }
    ],
    now,
    { exchangeRates: "USD:TWD=32.1" }
  );

  const sql = projection.statements.join("\n");
  assert.match(sql, /'Firstrade firstrade-main'/);
  assert.match(sql, /currency=excluded.currency/);
  assert.match(sql, /'TWD'/);
  assert.match(sql, /'PLTR PALANTIR TECHNOLOGIES INC'/);
  assert.match(sql, /'PALANTIR TECHNOLOGIES INC'/);
  assert.match(sql, /'43338\.21'/);
  assert.match(sql, /'49107\.543'/);
  assert.match(sql, /'2026-06-07'/);
  assert.match(sql, /'4333\.821'/);
  assert.match(sql, /'5769\.333'/);
  assert.doesNotMatch(sql, /'P054244', 'Imported from firstrade-qfx'/);
  assert.equal(projection.summary[0].positions, 1);
  assert.equal(projection.summary[0].cashCurrencies, 1);
  assert.equal(projection.summary[0].quotes, 1);
  assert.equal(brokerDisplayName("firstrade"), "Firstrade");
  assert.equal(brokerDisplayName("sinopac"), "SinoPac");
});
