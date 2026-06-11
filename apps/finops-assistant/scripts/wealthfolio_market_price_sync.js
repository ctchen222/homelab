#!/usr/bin/env node

const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { readFileSync, existsSync } = require("node:fs");

const TWSE_DAILY_URL = "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL";
const TPEX_DAILY_URL = "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes";
const YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?range=5d&interval=1d";

function stableId(prefix, parts) {
  const hash = createHash("sha256").update(parts.join("\u001f")).digest("hex").slice(0, 24);
  return `${prefix}-${hash}`;
}

function quoteSql(value) {
  if (value === null || value === undefined) return "NULL";
  return `'${String(value).replace(/'/g, "''")}'`;
}

function decimalText(value, fallback = "0") {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? String(value) : fallback;
}

function parseExchangeRates(value) {
  const rates = {};
  for (const entry of String(value || "").split(",")) {
    const [pair, rate] = entry.split("=");
    if (!pair || !rate) continue;
    const normalizedPair = pair.trim().toUpperCase();
    const parsedRate = Number(rate);
    if (!/^[A-Z]{3}:[A-Z]{3}$/.test(normalizedPair) || !Number.isFinite(parsedRate) || parsedRate <= 0) continue;
    rates[normalizedPair] = String(parsedRate);
  }
  return rates;
}

function exchangeRate(fromCurrency, toCurrency, rates) {
  const from = String(fromCurrency || "").toUpperCase();
  const to = String(toCurrency || "").toUpperCase();
  if (!from || !to || from === to) return "1";
  return rates[`${from}:${to}`] || null;
}

function convertMoney(value, fromCurrency, toCurrency, rates) {
  const rate = exchangeRate(fromCurrency, toCurrency, rates);
  if (!rate) return { amount: decimalText(value), currency: fromCurrency || toCurrency || "TWD", rate: null };
  return { amount: String(Number(decimalText(value)) * Number(rate)), currency: toCurrency, rate };
}

function snapshotDate(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return new Date().toISOString().slice(0, 10);
  return parsed.toISOString().slice(0, 10);
}

function runJsonQuery(dbPath, sql) {
  const output = execFileSync("sqlite3", ["-json", dbPath, sql], { encoding: "utf8" }).trim();
  return output ? JSON.parse(output) : [];
}

function runSql(dbPath, sql) {
  execFileSync("sqlite3", [dbPath], { input: sql, encoding: "utf8" });
}

function asFloat(value) {
  if (value === null || value === undefined) return null;
  const parsed = Number(String(value).replace(/,/g, "").replace(/--/g, "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

async function fetchJson(url, timeoutMs = 15000) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "homelab-finops-market-price-sync/0.1"
    },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    throw new Error(`price provider returned ${response.status} for ${url}`);
  }
  return response.json();
}

function loadFixtures(path) {
  if (!path || !existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8"));
}

function buildHoldingsUniverse(portfolioDbPath, brokers) {
  const brokerList = brokers.filter(Boolean);
  const brokerFilter = brokerList.length > 0 ? `AND broker_id IN (${brokerList.map(quoteSql).join(", ")})` : "";
  return runJsonQuery(
    portfolioDbPath,
    `
      WITH ranked AS (
        SELECT
          sync_run_id,
          broker_id,
          account_alias,
          base_currency,
          as_of,
          created_at,
          ROW_NUMBER() OVER (PARTITION BY broker_id, account_alias ORDER BY created_at DESC) AS rn
        FROM portfolio_sync_runs
        WHERE freshness_status IN ('fresh', 'partial')
          ${brokerFilter}
      )
      SELECT
        r.sync_run_id,
        r.broker_id,
        r.account_alias,
        r.base_currency,
        r.as_of,
        h.market,
        h.symbol,
        h.provider_symbol,
        h.security_name,
        h.currency,
        h.last_price
      FROM ranked r
      JOIN portfolio_holdings h ON h.sync_run_id = r.sync_run_id
      WHERE r.rn = 1
        AND CAST(COALESCE(h.quantity, '0') AS REAL) != 0
      ORDER BY r.broker_id, r.account_alias, h.market, h.symbol;
    `
  );
}

function providerLookupSymbol(holding) {
  const market = String(holding.market || "").toUpperCase();
  if (market === "TWSE" || market === "TPEX") {
    return holding.provider_symbol || holding.symbol;
  }
  return holding.symbol || holding.provider_symbol;
}

function yahooLookupSymbol(holding) {
  return holding.symbol || holding.provider_symbol;
}

function normalizeMarketQuote(holding, source, currentPrice, sourceCurrency, notes, asOf) {
  return {
    assetId: stableId("finops-asset", [holding.broker_id, holding.market, holding.symbol]),
    brokerId: holding.broker_id,
    accountAlias: holding.account_alias,
    market: holding.market,
    symbol: holding.symbol,
    providerSymbol: holding.provider_symbol || "",
    securityName: holding.security_name || holding.symbol,
    source,
    sourceCurrency,
    currentPrice,
    notes,
    asOf
  };
}

async function lookupTwseQuote(holding, context) {
  const providerSymbol = providerLookupSymbol(holding);
  const fixture = context.fixtures[providerSymbol];
  if (fixture && fixture.currentPrice !== undefined) {
    return normalizeMarketQuote(
      holding,
      "fixture",
      asFloat(fixture.currentPrice),
      holding.currency || context.displayCurrency,
      fixture.notes || ["Offline fixture quote"],
      context.today
    );
  }

  if (!context.twseRows) {
    context.twseRows = await context.fetcher(TWSE_DAILY_URL);
  }
  for (const row of context.twseRows) {
    if (String(row.Code || "") !== String(providerSymbol)) continue;
    return normalizeMarketQuote(
      holding,
      "twse-openapi",
      asFloat(row.ClosingPrice),
      holding.currency || context.displayCurrency,
      ["TWSE official end-of-day data"],
      context.today
    );
  }
  throw new Error(`TWSE symbol not found: ${providerSymbol}`);
}

async function lookupTpexQuote(holding, context) {
  const providerSymbol = providerLookupSymbol(holding);
  const fixture = context.fixtures[providerSymbol];
  if (fixture && fixture.currentPrice !== undefined) {
    return normalizeMarketQuote(
      holding,
      "fixture",
      asFloat(fixture.currentPrice),
      holding.currency || context.displayCurrency,
      fixture.notes || ["Offline fixture quote"],
      context.today
    );
  }

  if (!context.tpexRows) {
    context.tpexRows = await context.fetcher(TPEX_DAILY_URL);
  }
  for (const row of context.tpexRows) {
    if (String(row.SecuritiesCompanyCode || row.Code || "") !== String(providerSymbol)) continue;
    return normalizeMarketQuote(
      holding,
      "tpex-openapi",
      asFloat(row.Close || row.LatestPrice),
      holding.currency || context.displayCurrency,
      ["TPEx official market data"],
      context.today
    );
  }
  throw new Error(`TPEx symbol not found: ${providerSymbol}`);
}

async function lookupYahooQuote(holding, context) {
  const lookupSymbol = yahooLookupSymbol(holding);
  const fixture = context.fixtures[lookupSymbol];
  if (fixture && fixture.currentPrice !== undefined) {
    return normalizeMarketQuote(
      holding,
      "fixture",
      asFloat(fixture.currentPrice),
      holding.currency || context.displayCurrency,
      fixture.notes || ["Offline fixture quote"],
      context.today
    );
  }

  const payload = await context.fetcher(YAHOO_CHART_URL.replace("{symbol}", encodeURIComponent(lookupSymbol)));
  const result = payload?.chart?.result?.[0];
  const closes = (((result || {}).indicators || {}).quote || [{}])[0]?.close || [];
  const usable = closes.filter((value) => value !== null && value !== undefined);
  if (usable.length === 0) {
    throw new Error(`yahoo quote unavailable: ${lookupSymbol}`);
  }
  return normalizeMarketQuote(
    holding,
    "yfinance-compatible",
    asFloat(usable[usable.length - 1]),
    holding.currency || context.displayCurrency,
    ["OpenBB/yfinance-compatible daily chart input"],
    context.today
  );
}

async function fetchMarketQuotes(holdings, options = {}) {
  const context = {
    fetcher: options.fetcher || fetchJson,
    fixtures: options.fixtures || {},
    twseRows: null,
    tpexRows: null,
    displayCurrency: String(options.displayCurrency || "TWD").toUpperCase(),
    today: snapshotDate(options.now || new Date().toISOString())
  };
  const quotes = [];
  const failures = [];

  for (const holding of holdings) {
    try {
      const market = String(holding.market || "").toUpperCase();
      let quote;
      if (market === "TWSE") {
        quote = await lookupTwseQuote(holding, context);
      } else if (market === "TPEX") {
        quote = await lookupTpexQuote(holding, context);
      } else {
        quote = await lookupYahooQuote(holding, context);
      }
      if (quote.currentPrice === null) {
        throw new Error(`price unavailable for ${holding.symbol}`);
      }
      quotes.push(quote);
    } catch (error) {
      failures.push({
        brokerId: holding.broker_id,
        accountAlias: holding.account_alias,
        market: holding.market,
        symbol: holding.symbol,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return { quotes, failures };
}

function buildQuoteStatements(quotes, options = {}) {
  const nowIso = new Date(options.now || new Date()).toISOString();
  const displayCurrency = String(options.displayCurrency || "TWD").toUpperCase();
  const exchangeRates = {
    "USD:TWD": "32.1",
    ...parseExchangeRates(options.exchangeRates || "")
  };
  const statements = [];
  const summary = [];

  for (const quote of quotes) {
    const converted = convertMoney(quote.currentPrice, quote.sourceCurrency, displayCurrency, exchangeRates);
    statements.push(`
      INSERT INTO quotes (
        id, asset_id, day, source, open, high, low, close, adjclose, volume,
        currency, notes, created_at, timestamp
      ) VALUES (
        ${quoteSql(stableId("finops-quote", [quote.assetId, quote.asOf, "FINOPS_MARKET"]))},
        ${quoteSql(quote.assetId)}, ${quoteSql(quote.asOf)}, 'FINOPS_MARKET',
        NULL, NULL, NULL, ${quoteSql(decimalText(converted.amount))}, NULL, NULL,
        ${quoteSql(displayCurrency)},
        ${quoteSql(`${quote.source} ${quote.notes.join("; ")}`)},
        ${quoteSql(nowIso)}, ${quoteSql(nowIso)}
      )
      ON CONFLICT(asset_id, day, source) DO UPDATE SET
        close=excluded.close,
        currency=excluded.currency,
        notes=excluded.notes,
        timestamp=excluded.timestamp;
    `);
    summary.push({
      brokerId: quote.brokerId,
      accountAlias: quote.accountAlias,
      market: quote.market,
      symbol: quote.symbol,
      source: quote.source,
      sourceCurrency: quote.sourceCurrency,
      displayCurrency,
      close: decimalText(converted.amount)
    });
  }

  return { statements, summary };
}

async function syncMarketPrices(options) {
  const brokers = String(options.brokers || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const holdings = buildHoldingsUniverse(options.portfolioDbPath, brokers);
  const { quotes, failures } = await fetchMarketQuotes(holdings, {
    fetcher: options.fetcher,
    fixtures: loadFixtures(options.fixturePath),
    displayCurrency: options.displayCurrency,
    now: options.now
  });
  const projection = buildQuoteStatements(quotes, {
    displayCurrency: options.displayCurrency,
    exchangeRates: options.exchangeRates,
    now: options.now
  });
  if (!options.dryRun && projection.statements.length > 0) {
    runSql(options.wealthfolioDbPath, ["BEGIN IMMEDIATE;", ...projection.statements, "COMMIT;"].join("\n"));
  }
  return {
    ok: failures.length === 0,
    dryRun: options.dryRun,
    holdings: holdings.length,
    quotesUpdated: projection.summary.length,
    failures
  };
}

async function main() {
  const result = await syncMarketPrices({
    portfolioDbPath: process.env.PORTFOLIO_DB_PATH || "/data/portfolio/portfolio.sqlite",
    wealthfolioDbPath: process.env.WEALTHFOLIO_DB_PATH || "/wfdata/wealthfolio.db",
    brokers: process.env.WEALTHFOLIO_PRICE_SYNC_BROKERS || "sinopac",
    displayCurrency: process.env.WEALTHFOLIO_PRICE_SYNC_DISPLAY_CURRENCY || "TWD",
    exchangeRates: process.env.WEALTHFOLIO_PRICE_SYNC_EXCHANGE_RATES || "USD:TWD=32.1",
    fixturePath: process.env.WEALTHFOLIO_PRICE_SYNC_FIXTURE_PATH || "",
    dryRun: process.env.WEALTHFOLIO_PRICE_SYNC_DRY_RUN === "true"
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2));
    process.exit(1);
  });
}

module.exports = {
  buildHoldingsUniverse,
  buildQuoteStatements,
  fetchMarketQuotes,
  parseExchangeRates,
  stableId,
  syncMarketPrices
};