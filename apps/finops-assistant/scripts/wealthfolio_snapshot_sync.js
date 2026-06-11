#!/usr/bin/env node

const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");

function stableId(prefix, parts) {
  const hash = createHash("sha256").update(parts.join("\u001f")).digest("hex").slice(0, 24);
  return `${prefix}-${hash}`;
}

function quoteSql(value) {
  if (value === null || value === undefined) return "NULL";
  return `'${String(value).replace(/'/g, "''")}'`;
}

function jsonText(value) {
  return JSON.stringify(value);
}

function decimalText(value, fallback = "0") {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? String(value) : fallback;
}

function decimalAdd(left, right) {
  return String(Number(decimalText(left)) + Number(decimalText(right)));
}

function decimalMultiply(left, right) {
  return String(Number(decimalText(left)) * Number(decimalText(right)));
}

function decimalDivide(left, right) {
  const divisor = Number(decimalText(right));
  if (!Number.isFinite(divisor) || divisor === 0) return decimalText(left);
  return String(Number(decimalText(left)) / divisor);
}

function isNonZeroDecimal(value) {
  return Number(decimalText(value)) !== 0;
}

function snapshotDate(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return new Date().toISOString().slice(0, 10);
  return parsed.toISOString().slice(0, 10);
}

function previousDate(value) {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return value;
  parsed.setUTCDate(parsed.getUTCDate() - 1);
  return parsed.toISOString().slice(0, 10);
}

function brokerDisplayName(brokerId) {
  const normalized = String(brokerId || "").toLowerCase();
  if (normalized === "sinopac") return "SinoPac";
  if (normalized === "firstrade") return "Firstrade";
  return String(brokerId || "Broker");
}

function marketMic(market) {
  const normalized = String(market || "").toUpperCase();
  if (normalized === "TWSE" || normalized === "TSE") return "XTAI";
  if (normalized === "TPEX" || normalized === "OTC") return "ROCO";
  if (normalized === "NASDAQ") return "XNAS";
  if (normalized === "NYSE") return "XNYS";
  return null;
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
  return { amount: decimalMultiply(value, rate), currency: toCurrency, rate };
}

function convertUnitPrice(value, fromCurrency, toCurrency, rates) {
  return convertMoney(value, fromCurrency, toCurrency, rates);
}

function holdingDisplayCode(holding) {
  const symbol = holding.symbol || holding.provider_symbol || "";
  const name = holding.security_name || "";
  if (!name || name === symbol) return symbol;
  return `${symbol} ${name}`;
}

function runJsonQuery(dbPath, sql) {
  const output = execFileSync("sqlite3", ["-json", dbPath, sql], { encoding: "utf8" }).trim();
  return output ? JSON.parse(output) : [];
}

function runSql(dbPath, sql) {
  execFileSync("sqlite3", [dbPath], { input: sql, encoding: "utf8" });
}

function loadLatestPortfolioSnapshots(portfolioDbPath, brokerId, accountAlias) {
  const accountFilter = accountAlias ? `AND account_alias = ${quoteSql(accountAlias)}` : "";
  const runs = runJsonQuery(
    portfolioDbPath,
    `
      WITH ranked AS (
        SELECT
          sync_run_id,
          broker_id,
          account_alias,
          source_type,
          source_name,
          source_timestamp,
          freshness_status,
          missing_fields_json,
          base_currency,
          as_of,
          created_at,
          ROW_NUMBER() OVER (PARTITION BY broker_id, account_alias ORDER BY created_at DESC) AS rn
        FROM portfolio_sync_runs
        WHERE broker_id = ${quoteSql(brokerId)}
          ${accountFilter}
          AND freshness_status IN ('fresh', 'partial')
      )
      SELECT * FROM ranked WHERE rn = 1;
    `
  );

  return runs.map((run) => {
    const syncRunId = run.sync_run_id;
    return {
      run,
      holdings: runJsonQuery(
        portfolioDbPath,
        `
          SELECT market, symbol, provider_symbol, security_name, asset_type, currency, quantity,
                 average_cost, cost_basis, last_price, market_value, unrealized_pnl, as_of
          FROM portfolio_holdings
          WHERE sync_run_id = ${quoteSql(syncRunId)}
          ORDER BY market, symbol;
        `
      ),
      cashBalances: runJsonQuery(
        portfolioDbPath,
        `
          SELECT currency, amount, balance_type, as_of
          FROM portfolio_cash_balances
          WHERE sync_run_id = ${quoteSql(syncRunId)}
          ORDER BY currency, balance_type;
        `
      ),
      activityRows: runJsonQuery(
        portfolioDbPath,
        `
          SELECT activity_type, symbol, currency, quantity, price, amount, amount_type, trade_date
          FROM portfolio_activity_rows
          WHERE sync_run_id = ${quoteSql(syncRunId)}
          ORDER BY trade_date, symbol;
        `
      )
    };
  });
}

function buildActivityCostBasis(activityRows) {
  const costs = {};
  for (const row of activityRows || []) {
    if (row.activity_type !== "buy" || !row.symbol) continue;
    const quantity = Number(decimalText(row.quantity));
    if (!Number.isFinite(quantity) || quantity <= 0) continue;
    const amount = row.amount ? Math.abs(Number(decimalText(row.amount))) : Number(decimalMultiply(row.price || "0", row.quantity));
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const key = String(row.symbol).toUpperCase();
    const existing = costs[key] || { quantity: 0, costBasis: 0, currency: row.currency };
    existing.quantity += quantity;
    existing.costBasis += amount;
    existing.currency = row.currency || existing.currency;
    costs[key] = existing;
  }
  return costs;
}

function buildWealthfolioProjection(snapshots, now = new Date(), options = {}) {
  const nowIso = now.toISOString();
  const displayCurrency = String(options.displayCurrency || "TWD").toUpperCase();
  const exchangeRates = {
    "USD:TWD": "32.1",
    ...parseExchangeRates(options.exchangeRates || "")
  };
  const statements = [];
  const summary = [];

  for (const snapshot of snapshots) {
    const run = snapshot.run;
    const accountId = stableId("finops-account", [run.broker_id, run.account_alias]);
    const date = snapshotDate(run.as_of || run.source_timestamp || run.created_at);
    const snapshotId = stableId("finops-wf-snapshot", [accountId, date]);
    const accountMeta = {
      managedBy: "finops-assistant",
      brokerId: run.broker_id,
      accountAlias: run.account_alias,
      sourceCurrency: run.base_currency,
      displayCurrency,
      exchangeRates,
      sourceType: run.source_type,
      sourceName: run.source_name,
      sourceTimestamp: run.source_timestamp,
      freshnessStatus: run.freshness_status,
      missingFields: safeJsonArray(run.missing_fields_json)
    };

    statements.push(`
      INSERT INTO accounts (
        id, name, account_type, "group", currency, is_default, is_active,
        created_at, updated_at, platform_id, account_number, meta, provider,
        provider_account_id, tracking_mode, is_archived
      ) VALUES (
        ${quoteSql(accountId)}, ${quoteSql(`${brokerDisplayName(run.broker_id)} ${run.account_alias}`)}, 'SECURITIES',
        ${quoteSql(run.broker_id)}, ${quoteSql(displayCurrency)}, 0, 1,
        ${quoteSql(nowIso)}, ${quoteSql(nowIso)}, NULL, NULL, ${quoteSql(jsonText(accountMeta))},
        'finops-assistant', ${quoteSql(`${run.broker_id}:${run.account_alias}`)}, 'HOLDINGS', 0
      )
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name,
        currency=excluded.currency,
        is_active=1,
        updated_at=excluded.updated_at,
        meta=excluded.meta,
        provider=excluded.provider,
        provider_account_id=excluded.provider_account_id,
        tracking_mode='HOLDINGS',
        is_archived=0;
    `);

    const positions = {};
    const openAssetIds = [];
    const activityCostBasis = buildActivityCostBasis(snapshot.activityRows);
    let totalCostBasis = "0";
    let positionCount = 0;
    let quoteCount = 0;

    for (const holding of snapshot.holdings) {
      if (!isNonZeroDecimal(holding.quantity)) {
        continue;
      }

      const assetId = stableId("finops-asset", [run.broker_id, holding.market, holding.symbol]);
      const mic = marketMic(holding.market);
      const displayCode = holdingDisplayCode(holding);
      const sourceCurrency = holding.currency || run.base_currency || displayCurrency;
      const activityCost = activityCostBasis[String(holding.symbol || "").toUpperCase()];
      const priceProjection = convertUnitPrice(holding.last_price || "0", sourceCurrency, displayCurrency, exchangeRates);
      const marketValueProjection = convertMoney(
        holding.market_value || decimalMultiply(holding.last_price || "0", holding.quantity),
        sourceCurrency,
        displayCurrency,
        exchangeRates
      );
      const activityCostBasisSource =
        activityCost && Math.abs(activityCost.quantity - Number(decimalText(holding.quantity))) < 0.000001 ? String(activityCost.costBasis) : "";
      const averageCostSource =
        holding.average_cost ||
        (activityCostBasisSource ? decimalDivide(activityCostBasisSource, holding.quantity) : "") ||
        (holding.cost_basis ? decimalDivide(holding.cost_basis, holding.quantity) : "") ||
        (holding.market_value ? decimalDivide(holding.market_value, holding.quantity) : holding.last_price);
      const averageCost = convertUnitPrice(averageCostSource || "0", sourceCurrency, displayCurrency, exchangeRates).amount;
      const costBasis = convertMoney(
        holding.cost_basis || activityCostBasisSource || holding.market_value || decimalMultiply(averageCostSource || "0", holding.quantity),
        sourceCurrency,
        displayCurrency,
        exchangeRates
      ).amount;
      const position = {
        id: `POS-${assetId}-${accountId}`,
        accountId,
        assetId,
        quantity: decimalText(holding.quantity),
        averageCost,
        totalCostBasis: costBasis,
        currency: displayCurrency,
        sourceCurrency,
        sourceMarketValue: holding.market_value || null,
        exchangeRate: marketValueProjection.rate,
        inceptionDate: holding.as_of || run.as_of || nowIso,
        lots: [],
        createdAt: nowIso,
        lastUpdated: nowIso,
        isAlternative: false,
        contractMultiplier: "1"
      };
      positions[assetId] = position;
      openAssetIds.push(assetId);
      totalCostBasis = decimalAdd(totalCostBasis, costBasis);
      positionCount += 1;

      statements.push(`
        INSERT INTO assets (
          id, kind, name, display_code, notes, metadata, is_active, quote_mode,
          quote_ccy, instrument_type, instrument_symbol, instrument_exchange_mic,
          provider_config, created_at, updated_at
        ) VALUES (
          ${quoteSql(assetId)}, 'INVESTMENT', ${quoteSql(holding.security_name || displayCode)},
          ${quoteSql(displayCode)}, ${quoteSql(`Imported from ${run.source_name}`)},
          ${quoteSql(jsonText({ managedBy: "finops-assistant", brokerId: run.broker_id, market: holding.market, sourceCurrency }))},
          1, 'MANUAL', ${quoteSql(displayCurrency)},
          'EQUITY', ${quoteSql(holding.symbol)}, ${quoteSql(mic)},
          NULL, ${quoteSql(nowIso)}, ${quoteSql(nowIso)}
        )
        ON CONFLICT(id) DO UPDATE SET
          name=excluded.name,
          display_code=excluded.display_code,
          notes=excluded.notes,
          metadata=excluded.metadata,
          is_active=1,
          quote_mode=excluded.quote_mode,
          quote_ccy=excluded.quote_ccy,
          instrument_type=excluded.instrument_type,
          instrument_symbol=excluded.instrument_symbol,
          instrument_exchange_mic=excluded.instrument_exchange_mic,
          updated_at=excluded.updated_at;
      `);

      if (holding.last_price || holding.market_value) {
        quoteCount += 1;
        const baselineDate = previousDate(date);
        statements.push(`
          INSERT INTO quotes (
            id, asset_id, day, source, open, high, low, close, adjclose, volume,
            currency, notes, created_at, timestamp
          ) VALUES (
            ${quoteSql(stableId("finops-quote", [assetId, date, "FINOPS_BROKER"]))},
            ${quoteSql(assetId)}, ${quoteSql(date)}, 'FINOPS_BROKER',
            NULL, NULL, NULL, ${quoteSql(decimalText(priceProjection.amount))}, NULL, NULL,
            ${quoteSql(displayCurrency)},
            ${quoteSql("Imported from FinOps broker snapshot")},
            ${quoteSql(nowIso)}, ${quoteSql(nowIso)}
          )
          ON CONFLICT(asset_id, day, source) DO UPDATE SET
            close=excluded.close,
            currency=excluded.currency,
            notes=excluded.notes,
            timestamp=excluded.timestamp;
        `);
        statements.push(`
          INSERT INTO quotes (
            id, asset_id, day, source, open, high, low, close, adjclose, volume,
            currency, notes, created_at, timestamp
          ) VALUES (
            ${quoteSql(stableId("finops-quote", [assetId, baselineDate, "FINOPS_COST_BASIS"]))},
            ${quoteSql(assetId)}, ${quoteSql(baselineDate)}, 'FINOPS_COST_BASIS',
            NULL, NULL, NULL, ${quoteSql(decimalText(averageCost))}, NULL, NULL,
            ${quoteSql(displayCurrency)},
            ${quoteSql("Cost-basis baseline for FinOps imported broker snapshot")},
            ${quoteSql(nowIso)}, ${quoteSql(nowIso)}
          )
          ON CONFLICT(asset_id, day, source) DO UPDATE SET
            close=excluded.close,
            currency=excluded.currency,
            notes=excluded.notes,
            timestamp=excluded.timestamp;
        `);
      }
    }

    const activeAssetExpression =
      openAssetIds.length > 0
        ? `CASE WHEN id IN (${openAssetIds.map(quoteSql).join(", ")}) THEN 1 ELSE 0 END`
        : "0";
    statements.push(`
      UPDATE assets
      SET
        quote_mode='MANUAL',
        is_active=${activeAssetExpression},
        updated_at=${quoteSql(nowIso)}
      WHERE json_extract(metadata, '$.managedBy') = 'finops-assistant'
        AND json_extract(metadata, '$.brokerId') = ${quoteSql(run.broker_id)};
    `);

    statements.push(`
      DELETE FROM quote_sync_state
      WHERE asset_id IN (
        SELECT id FROM assets
        WHERE json_extract(metadata, '$.managedBy') = 'finops-assistant'
          AND json_extract(metadata, '$.brokerId') = ${quoteSql(run.broker_id)}
      );
    `);

    const staleAssetFilter =
      openAssetIds.length > 0
        ? `AND id NOT IN (${openAssetIds.map(quoteSql).join(", ")})`
        : "";
    statements.push(`
      DELETE FROM assets
      WHERE json_extract(metadata, '$.managedBy') = 'finops-assistant'
        AND json_extract(metadata, '$.brokerId') = ${quoteSql(run.broker_id)}
        ${staleAssetFilter};
    `);

    const cashBalances = {};
    let cashTotal = "0";
    for (const cash of snapshot.cashBalances) {
      const currency = cash.currency || run.base_currency || displayCurrency;
      const converted = convertMoney(cash.amount, currency, displayCurrency, exchangeRates);
      cashBalances[displayCurrency] = decimalAdd(cashBalances[displayCurrency] || "0", converted.amount);
      cashTotal = decimalAdd(cashTotal, converted.amount);
    }
    const netContribution = decimalAdd(totalCostBasis, cashTotal);

    statements.push(`
      INSERT OR REPLACE INTO holdings_snapshots (
        id, account_id, snapshot_date, currency, positions, cash_balances,
        cost_basis, net_contribution, calculated_at, net_contribution_base,
        cash_total_account_currency, cash_total_base_currency, source
      ) VALUES (
        ${quoteSql(snapshotId)}, ${quoteSql(accountId)}, ${quoteSql(date)},
        ${quoteSql(displayCurrency)}, ${quoteSql(jsonText(positions))},
        ${quoteSql(jsonText(cashBalances))}, ${quoteSql(totalCostBasis)}, ${quoteSql(netContribution)},
        ${quoteSql(nowIso)}, ${quoteSql(netContribution)}, ${quoteSql(cashTotal)}, ${quoteSql(cashTotal)},
        'BROKER_IMPORTED'
      );
    `);

    summary.push({
      brokerId: run.broker_id,
      accountAlias: run.account_alias,
      accountId,
      snapshotDate: date,
      freshnessStatus: run.freshness_status,
      missingFields: safeJsonArray(run.missing_fields_json),
      positions: positionCount,
      cashCurrencies: Object.keys(cashBalances).length,
      quotes: quoteCount
    });
  }

  return { statements, summary };
}

function safeJsonArray(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function syncPortfolioToWealthfolio(options) {
  const snapshots = loadLatestPortfolioSnapshots(options.portfolioDbPath, options.brokerId, options.accountAlias);
  const projection = buildWealthfolioProjection(snapshots, new Date(), {
    displayCurrency: options.displayCurrency,
    exchangeRates: options.exchangeRates
  });
  if (!options.dryRun && projection.statements.length > 0) {
    runSql(options.wealthfolioDbPath, ["BEGIN IMMEDIATE;", ...projection.statements, "COMMIT;"].join("\n"));
  }
  return {
    ok: true,
    dryRun: options.dryRun,
    snapshots: projection.summary.length,
    accounts: projection.summary
  };
}

function main() {
  const options = {
    portfolioDbPath: process.env.PORTFOLIO_DB_PATH || "/data/portfolio/portfolio.sqlite",
    wealthfolioDbPath: process.env.WEALTHFOLIO_DB_PATH || "/data/wealthfolio/wealthfolio.db",
    brokerId: process.env.WEALTHFOLIO_SYNC_BROKER_ID || "sinopac",
    accountAlias: process.env.WEALTHFOLIO_SYNC_ACCOUNT_ALIAS || "",
    displayCurrency: process.env.WEALTHFOLIO_DISPLAY_CURRENCY || "TWD",
    exchangeRates: process.env.WEALTHFOLIO_EXCHANGE_RATES || "USD:TWD=32.1",
    dryRun: process.env.WEALTHFOLIO_SYNC_DRY_RUN === "true"
  };
  const result = syncPortfolioToWealthfolio(options);
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = {
  brokerDisplayName,
  buildWealthfolioProjection,
  marketMic,
  parseExchangeRates,
  stableId,
  syncPortfolioToWealthfolio
};
