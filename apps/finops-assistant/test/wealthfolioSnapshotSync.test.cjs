const test = require("node:test");
const assert = require("node:assert/strict");
const {
  brokerDisplayName,
  buildWealthfolioProjection,
  marketMic,
  stableId
} = require("../scripts/wealthfolio_snapshot_sync.js");

test("Wealthfolio snapshot sync builds holdings-mode projection from normalized broker snapshot", () => {
  const now = new Date("2026-06-08T03:00:00.000Z");
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
          as_of: "2026-06-08T02:39:18.000Z",
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
  assert.match(sql, /'MANUAL'/);
  assert.match(sql, /DELETE FROM quote_sync_state/);
  assert.match(sql, /DELETE FROM assets/);
  assert.match(sql, /id NOT IN/);
  assert.doesNotMatch(sql, /Closed Holding/);
  assert.doesNotMatch(sql, /undefined/);
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
