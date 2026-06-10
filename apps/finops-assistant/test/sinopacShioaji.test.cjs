const test = require("node:test");
const assert = require("node:assert/strict");
const { createSinoPacShioajiDryRunConnector, createSinoPacShioajiLiveConnector } = require("../dist/sinopacShioaji.js");

test("SinoPac Shioaji dry-run connector normalizes stock positions", async () => {
  const connector = createSinoPacShioajiDryRunConnector({
    readStockPositions: async () => [
      {
        market: "TWSE",
        code: "2330",
        name: "TSMC",
        quantity: 10,
        averageCost: "700.00",
        costBasis: "7000.00",
        lastPrice: "850.00",
        marketValue: "8500.00",
        unrealizedPnl: "1500.00",
        unrealizedPnlPercent: "21.43",
        asOf: "2026-06-05T01:00:00.000Z"
      }
    ]
  });
  const descriptor = connector.describe();

  assert.equal(descriptor.adapterId, "sinopac-shioaji");
  assert.equal(descriptor.brokerId, "sinopac");
  assert.equal(descriptor.credentialMode, "none");
  assert.equal(descriptor.productionStatus, "dry-run");

  const snapshot = await connector.syncSnapshot({
    accountAlias: "sinopac-main",
    mode: "dry-run",
    requestedAt: "2026-06-05T02:00:00.000Z"
  });

  assert.equal(snapshot.sourceFreshness.status, "fresh");
  assert.equal(snapshot.sourceFreshness.sourceTimestamp, "2026-06-05T01:00:00.000Z");
  assert.equal(snapshot.holdings.length, 1);
  assert.equal(snapshot.holdings[0].symbol, "2330");
  assert.equal(snapshot.holdings[0].currency, "TWD");
  assert.equal(snapshot.holdings[0].marketValue, "8500.00");
  assert.equal(snapshot.cashBalances.length, 0);
});

test("SinoPac Shioaji dry-run connector marks missing valuation fields as partial", async () => {
  const connector = createSinoPacShioajiDryRunConnector({
    readStockPositions: () => [{ market: "TPEx", code: "6488", quantity: "3", asOf: "2026-06-05T01:00:00.000Z" }]
  });

  const snapshot = await connector.syncSnapshot({
    accountAlias: "sinopac-main",
    mode: "dry-run",
    requestedAt: "2026-06-05T02:00:00.000Z"
  });

  assert.equal(snapshot.sourceFreshness.status, "partial");
  assert.deepEqual(snapshot.sourceFreshness.missingFields, [
    "holdings.averageCost",
    "holdings.costBasis",
    "holdings.marketValue"
  ]);
  assert.equal(snapshot.holdings[0].freshnessStatus, "partial");
});

test("SinoPac Shioaji dry-run connector rejects live mode", () => {
  const connector = createSinoPacShioajiDryRunConnector({ readStockPositions: () => [] });
  const preflight = connector.preflight({
    accountAlias: "sinopac-main",
    mode: "live-read",
    requestedAt: "2026-06-05T02:00:00.000Z"
  });

  assert.equal(preflight.ok, false);
  assert.equal(preflight.status, "rejected");
  assert.equal(preflight.errorClass, "unsafe-input");
});

test("SinoPac Shioaji live connector accepts live-read mode and read-only credentials", async () => {
  const connector = createSinoPacShioajiLiveConnector({
    preflight: () => ({ ok: true, status: "succeeded" }),
    readStockPositions: () => [
      {
        market: "TWSE",
        code: "2330",
        quantity: "10",
        averageCost: "700",
        costBasis: "7000",
        marketValue: "8500",
        asOf: "2026-06-05T01:00:00.000Z"
      }
    ],
    readCashBalances: () => [{ currency: "TWD", amount: "12345", balanceType: "available", asOf: "2026-06-05T01:00:00.000Z" }]
  });
  const descriptor = connector.describe();

  assert.equal(descriptor.credentialMode, "read-only-secret");
  assert.equal(descriptor.productionStatus, "approved-read-only");

  const preflight = await connector.preflight({
    accountAlias: "sinopac-main",
    mode: "live-read",
    requestedAt: "2026-06-05T02:00:00.000Z"
  });
  const snapshot = await connector.syncSnapshot({
    accountAlias: "sinopac-main",
    mode: "live-read",
    requestedAt: "2026-06-05T02:00:00.000Z"
  });

  assert.equal(preflight.ok, true);
  assert.equal(snapshot.syncRunId.startsWith("sinopac-shioaji-live-read-"), true);
  assert.equal(snapshot.holdings[0].symbol, "2330");
  assert.equal(snapshot.cashBalances[0].amount, "12345");
});

test("SinoPac Shioaji live connector rejects dry-run mode", async () => {
  const connector = createSinoPacShioajiLiveConnector({ readStockPositions: () => [] });
  const preflight = await connector.preflight({
    accountAlias: "sinopac-main",
    mode: "dry-run",
    requestedAt: "2026-06-05T02:00:00.000Z"
  });

  assert.equal(preflight.ok, false);
  assert.equal(preflight.status, "rejected");
  assert.equal(preflight.errorClass, "unsafe-input");
});

test("SinoPac Shioaji dry-run connector syncs cash balances when endpoint is available", async () => {
  const connector = createSinoPacShioajiDryRunConnector({
    readStockPositions: () => [],
    readCashBalances: () => [{ currency: "TWD", amount: "12345.00", balanceType: "settled", asOf: "2026-06-05T01:00:00.000Z" }]
  });

  assert.equal(connector.describe().supportsCash, true);

  const snapshot = await connector.syncSnapshot({
    accountAlias: "sinopac-main",
    mode: "dry-run",
    requestedAt: "2026-06-05T02:00:00.000Z"
  });

  assert.equal(snapshot.sourceFreshness.status, "fresh");
  assert.equal(snapshot.cashBalances.length, 1);
  assert.equal(snapshot.cashBalances[0].amount, "12345.00");
  assert.equal(snapshot.cashBalances[0].currency, "TWD");
});

test("SinoPac Shioaji dry-run connector marks cash endpoint failure as partial", async () => {
  const connector = createSinoPacShioajiDryRunConnector({
    readStockPositions: () => [
      {
        market: "TWSE",
        code: "2330",
        quantity: "1",
        averageCost: "700.00",
        costBasis: "700.00",
        marketValue: "850.00",
        asOf: "2026-06-05T01:00:00.000Z"
      }
    ],
    readCashBalances: () => {
      throw new Error("permission denied for balance endpoint");
    }
  });

  const snapshot = await connector.syncSnapshot({
    accountAlias: "sinopac-main",
    mode: "dry-run",
    requestedAt: "2026-06-05T02:00:00.000Z"
  });

  assert.equal(snapshot.sourceFreshness.status, "partial");
  assert.deepEqual(snapshot.sourceFreshness.missingFields, ["cashBalances"]);
  assert.equal(snapshot.errors[0].errorClass, "permission-denied");
  assert.equal(snapshot.cashBalances.length, 0);
});

test("SinoPac Shioaji dry-run connector marks failed authentication for stock sync", async () => {
  const connector = createSinoPacShioajiDryRunConnector({
    readStockPositions: () => {
      throw new Error("authentication failed for stock endpoint");
    }
  });

  const snapshot = await connector.syncSnapshot({
    accountAlias: "sinopac-main",
    mode: "dry-run",
    requestedAt: "2026-06-05T02:00:00.000Z"
  });

  assert.equal(snapshot.sourceFreshness.status, "failed");
  assert.equal(snapshot.holdings.length, 0);
  assert.equal(snapshot.errors[0].errorClass, "auth-failed");
  assert.equal(snapshot.errors[0].message.includes("authentication failed for stock endpoint"), true);
});

test("SinoPac Shioaji dry-run connector exposes read-only operations only", async () => {
  const connector = createSinoPacShioajiDryRunConnector({
    readStockPositions: () => []
  });

  assert.equal(typeof connector.syncSnapshot, "function");
  assert.equal(typeof connector.preflight, "function");
  assert.equal("placeOrder" in connector, false);
  assert.equal("modifyOrder" in connector, false);
  assert.equal("withdrawFunds" in connector, false);
});
