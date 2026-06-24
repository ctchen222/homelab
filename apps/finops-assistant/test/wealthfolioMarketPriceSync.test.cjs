const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { execFileSync } = require("node:child_process");
const {
  buildHoldingsUniverse,
  buildQuoteStatements,
  fetchMarketQuotes,
  syncMarketPrices,
  stableId
} = require("../scripts/wealthfolio_market_price_sync.js");

function makePortfolioDb() {
  const dir = mkdtempSync(join(tmpdir(), "wf-market-price-sync-"));
  const dbPath = join(dir, "portfolio.sqlite");
  execFileSync("sqlite3", [dbPath], {
    input: `
      CREATE TABLE portfolio_sync_runs (
        sync_run_id TEXT PRIMARY KEY,
        broker_id TEXT NOT NULL,
        account_alias TEXT NOT NULL,
        base_currency TEXT NOT NULL,
        as_of TEXT NOT NULL,
        freshness_status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE portfolio_holdings (
        sync_run_id TEXT NOT NULL,
        market TEXT NOT NULL,
        symbol TEXT NOT NULL,
        provider_symbol TEXT,
        security_name TEXT,
        currency TEXT NOT NULL,
        quantity TEXT NOT NULL,
        last_price TEXT
      );
    `,
    encoding: "utf8"
  });
  return dbPath;
}

function makeWealthfolioDb() {
  const dir = mkdtempSync(join(tmpdir(), "wf-market-price-target-"));
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
    `,
    encoding: "utf8"
  });
  return dbPath;
}

test("buildHoldingsUniverse returns latest non-zero holdings for selected brokers", () => {
  const dbPath = makePortfolioDb();
  execFileSync("sqlite3", [dbPath], {
    input: `
      INSERT INTO portfolio_sync_runs VALUES
        ('sync-old', 'sinopac', 'sinopac-main', 'TWD', '2026-06-10T02:00:00.000Z', 'fresh', '2026-06-10T02:00:01.000Z'),
        ('sync-new', 'sinopac', 'sinopac-main', 'TWD', '2026-06-11T02:00:00.000Z', 'partial', '2026-06-11T02:00:01.000Z'),
        ('sync-us', 'firstrade', 'firstrade-main', 'USD', '2026-06-11T02:00:00.000Z', 'fresh', '2026-06-11T02:00:01.000Z');
      INSERT INTO portfolio_holdings VALUES
        ('sync-old', 'TWSE', '2330', '2330', 'TSMC', 'TWD', '10', '900'),
        ('sync-new', 'TWSE', '2330', '2330', 'TSMC', 'TWD', '12', '950'),
        ('sync-new', 'TWSE', '0056', '0056', 'ETF', 'TWD', '0', '40'),
        ('sync-us', 'NASDAQ', 'QQQ', 'QQQ', 'QQQ ETF', 'USD', '3', '510');
    `,
    encoding: "utf8"
  });

  const rows = buildHoldingsUniverse(dbPath, ["sinopac", "firstrade"]);
  assert.equal(rows.length, 2);
  const symbols = rows.map((row) => row.symbol).sort();
  assert.deepEqual(symbols, ["2330", "QQQ"]);
  assert.equal(rows.find((row) => row.symbol === "2330").sync_run_id, "sync-new");
});

test("syncMarketPrices with sinopac-only filter does not touch firstrade holdings", async () => {
  const portfolioDbPath = makePortfolioDb();
  const wealthfolioDbPath = makeWealthfolioDb();
  const fixtureDir = mkdtempSync(join(tmpdir(), "wf-market-price-fixture-"));
  const fixturePath = join(fixtureDir, "prices.json");

  execFileSync("sqlite3", [portfolioDbPath], {
    input: `
      INSERT INTO portfolio_sync_runs VALUES
        ('sync-tw', 'sinopac', 'sinopac-main', 'TWD', '2026-06-11T02:00:00.000Z', 'partial', '2026-06-11T02:00:01.000Z'),
        ('sync-us', 'firstrade', 'firstrade-main', 'USD', '2026-06-11T02:00:00.000Z', 'partial', '2026-06-11T02:00:01.000Z');
      INSERT INTO portfolio_holdings VALUES
        ('sync-tw', 'TWSE', '2330', '2330', 'TSMC', 'TWD', '12', '950'),
        ('sync-us', 'NASDAQ', 'QQQ', 'C078361', 'QQQ ETF', 'USD', '3', '510');
    `,
    encoding: "utf8"
  });

  writeFileSync(
    fixturePath,
    JSON.stringify({
      "2330": { currentPrice: 1000, notes: ["fixture tw"] }
    }),
    "utf8"
  );

  const result = await syncMarketPrices({
    portfolioDbPath,
    wealthfolioDbPath,
    brokers: "sinopac",
    displayCurrency: "TWD",
    exchangeRates: "USD:TWD=32.1",
    fixturePath,
    now: "2026-06-11T03:00:00.000Z",
    dryRun: false
  });

  assert.equal(result.ok, true);
  assert.equal(result.quotesUpdated, 1);
  const rows = JSON.parse(
    execFileSync(
      "sqlite3",
      [
        "-json",
        wealthfolioDbPath,
        "SELECT source, asset_id, day FROM quotes ORDER BY source;"
      ],
      { encoding: "utf8" }
    )
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, "FINOPS_MARKET");
  assert.equal(rows[0].asset_id, stableId("finops-asset", ["sinopac", "TWSE", "2330"]));
});

test("fetchMarketQuotes resolves TWSE and Yahoo-compatible quotes", async () => {
  const holdings = [
    {
      broker_id: "sinopac",
      account_alias: "sinopac-main",
      market: "TWSE",
      symbol: "2330",
      provider_symbol: "2330",
      security_name: "TSMC",
      currency: "TWD"
    },
    {
      broker_id: "firstrade",
      account_alias: "firstrade-main",
      market: "NASDAQ",
      symbol: "QQQ",
      provider_symbol: "C078361",
      security_name: "QQQ ETF",
      currency: "USD"
    }
  ];

  const { quotes, failures } = await fetchMarketQuotes(holdings, {
    displayCurrency: "TWD",
    now: "2026-06-11T03:00:00.000Z",
    fetcher: async (url) => {
      if (url.includes("STOCK_DAY_ALL")) {
        return [{ Code: "2330", ClosingPrice: "1000" }];
      }
      if (url.includes("finance/chart/QQQ")) {
        return { chart: { result: [{ indicators: { quote: [{ close: [500.1, 510.5] }] } }] } };
      }
      throw new Error(`unexpected url: ${url}`);
    }
  });

  assert.equal(failures.length, 0);
  assert.equal(quotes.length, 2);
  assert.equal(quotes[0].source, "twse-openapi");
  assert.equal(quotes[1].source, "yfinance-compatible");
  assert.equal(quotes[1].currentPrice, 510.5);
});

test("syncMarketPrices writes converted FINOPS_MARKET quotes into Wealthfolio", async () => {
  const portfolioDbPath = makePortfolioDb();
  const wealthfolioDbPath = makeWealthfolioDb();
  const fixtureDir = mkdtempSync(join(tmpdir(), "wf-market-price-fixture-"));
  const fixturePath = join(fixtureDir, "prices.json");

  execFileSync("sqlite3", [portfolioDbPath], {
    input: `
      INSERT INTO portfolio_sync_runs VALUES
        ('sync-tw', 'sinopac', 'sinopac-main', 'TWD', '2026-06-11T02:00:00.000Z', 'partial', '2026-06-11T02:00:01.000Z'),
        ('sync-us', 'firstrade', 'firstrade-main', 'USD', '2026-06-11T02:00:00.000Z', 'partial', '2026-06-11T02:00:01.000Z');
      INSERT INTO portfolio_holdings VALUES
        ('sync-tw', 'TWSE', '2330', '2330', 'TSMC', 'TWD', '12', '950'),
        ('sync-us', 'NASDAQ', 'QQQ', 'C078361', 'QQQ ETF', 'USD', '3', '510');
    `,
    encoding: "utf8"
  });

  writeFileSync(
    fixturePath,
    JSON.stringify({
      "2330": { currentPrice: 1000, notes: ["fixture tw"] },
      QQQ: { currentPrice: 510.5, notes: ["fixture us"] }
    }),
    "utf8"
  );

  const result = await syncMarketPrices({
    portfolioDbPath,
    wealthfolioDbPath,
    brokers: "sinopac,firstrade",
    displayCurrency: "TWD",
    exchangeRates: "USD:TWD=32.1",
    fixturePath,
    now: "2026-06-11T03:00:00.000Z",
    dryRun: false
  });

  assert.equal(result.ok, true);
  assert.equal(result.quotesUpdated, 2);

  const rows = JSON.parse(
    execFileSync(
      "sqlite3",
      [
        "-json",
        wealthfolioDbPath,
        "SELECT asset_id, day, source, close, currency, notes FROM quotes ORDER BY asset_id;"
      ],
      { encoding: "utf8" }
    )
  );

  assert.equal(rows.length, 2);
  assert.equal(rows[0].source, "FINOPS_MARKET");
  assert.equal(rows[0].currency, "TWD");
  assert.equal(rows[0].close, "1000");
  assert.equal(rows[1].close, "16387.05");
  assert.equal(rows[1].asset_id, stableId("finops-asset", ["firstrade", "NASDAQ", "QQQ"]));
});

test("buildQuoteStatements uses FINOPS_MARKET source and converted display currency", () => {
  const projection = buildQuoteStatements(
    [
      {
        assetId: stableId("finops-asset", ["firstrade", "NASDAQ", "QQQ"]),
        brokerId: "firstrade",
        accountAlias: "firstrade-main",
        market: "NASDAQ",
        symbol: "QQQ",
        source: "yfinance-compatible",
        sourceCurrency: "USD",
        currentPrice: 510.5,
        notes: ["fixture"],
        asOf: "2026-06-11"
      }
    ],
    { displayCurrency: "TWD", exchangeRates: "USD:TWD=32.1", now: "2026-06-11T03:00:00.000Z" }
  );

  assert.equal(projection.summary.length, 1);
  assert.equal(projection.summary[0].close, "16387.05");
  assert.match(projection.statements.join("\n"), /FINOPS_MARKET/);
  assert.match(projection.statements.join("\n"), /yfinance-compatible fixture/);
});