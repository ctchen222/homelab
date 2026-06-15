const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { createRequestHandler } = require("../dist/app.js");
const { PortfolioStore } = require("../dist/portfolioStore.js");

const baseConfig = {
  port: 8090,
  telegramBotToken: "telegram-token",
  telegramWebhookSecret: "webhook-secret",
  telegramAllowedUserIds: new Set([100]),
  assistantInternalToken: "internal-token",
  ezBookkeepingAccountIds: {},
  ezBookkeepingCategoryIds: {},
  defaultCurrency: "TWD",
  assistantDbPath: ":memory:",
  portfolioDbPath: "/tmp/portfolio.sqlite",
  portfolioExportDir: "/tmp/portfolio-exports",
  portfolioAccountIdentitySalt: "test-salt",
  portfolioWriterLeaseMinutes: 30,
  portfolioSnapshotRetentionDays: 30,
  portfolioExportRetentionDays: 90,
  portfolioRawImportRetentionDays: 90,
  reportDir: "/tmp",
  watchlistPath: "/tmp/watchlist.json",
  timezone: "Asia/Taipei",
  llmEnabled: false
};

function store() {
  return {
    isProcessed: () => false,
    markProcessed: () => undefined,
    addPendingReview: () => undefined,
    pendingReviewCount: () => 3,
    recordReport: () => undefined
  };
}

function request(method, url, body, headers = {}) {
  return {
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) {
        yield Buffer.from(JSON.stringify(body));
      }
    }
  };
}

async function dispatch(handler, req) {
  const chunks = [];
  const response = {
    statusCode: 0,
    headers: {},
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(payload) {
      chunks.push(payload);
    }
  };

  await handler(req, response);
  return {
    statusCode: response.statusCode,
    headers: response.headers,
    body: JSON.parse(chunks.join(""))
  };
}

function minutesAgoIso(minutes) {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

function nowIso() {
  return minutesAgoIso(0);
}

test("health endpoint returns ok without dependencies", async () => {
  const handler = createRequestHandler(baseConfig, store());
  const response = await dispatch(handler, request("GET", "/healthz"));

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { ok: true });
});

test("ready endpoint includes pending review count", async () => {
  const handler = createRequestHandler(baseConfig, store());
  const response = await dispatch(handler, request("GET", "/readyz"));

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.pendingReviews, 3);
});

test("telegram webhook rejects invalid secret before parsing body", async () => {
  const handler = createRequestHandler(baseConfig, store(), {
    handleTelegramUpdate: async () => {
      throw new Error("should not be called");
    }
  });

  const response = await dispatch(
    handler,
    request("POST", "/telegram/webhook", { update_id: 1 }, { "x-telegram-bot-api-secret-token": "bad-secret" })
  );

  assert.equal(response.statusCode, 403);
  assert.equal(response.body.error, "forbidden");
});

test("telegram webhook delegates valid updates", async () => {
  let seenUpdate;
  const handler = createRequestHandler(baseConfig, store(), {
    handleTelegramUpdate: async (update) => {
      seenUpdate = update;
      return { status: "accepted", message: "ok" };
    }
  });

  const response = await dispatch(
    handler,
    request("POST", "/telegram/webhook", { update_id: 7 }, { "x-telegram-bot-api-secret-token": "webhook-secret" })
  );

  assert.equal(response.statusCode, 200);
  assert.deepEqual(seenUpdate, { update_id: 7 });
});

test("telegram webhook can reply through webhook response without outbound Bot API", async () => {
  const handler = createRequestHandler(baseConfig, store());

  const response = await dispatch(
    handler,
    request(
      "POST",
      "/telegram/webhook",
      {
        update_id: 8,
        message: {
          from: { id: 100 },
          chat: { id: 100 },
          text: "status"
        }
      },
      { "x-telegram-bot-api-secret-token": "webhook-secret" }
    )
  );

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    method: "sendMessage",
    chat_id: 100,
    text: "FinOps assistant ready. Pending reviews: 3.",
    disable_web_page_preview: true
  });
});

test("telegram webhook preserves inline keyboard in webhook reply", async () => {
  const handler = createRequestHandler(baseConfig, store(), {
    handleTelegramUpdate: async (_update, _config, _store, { fetchImpl }) => {
      await fetchImpl("https://api.telegram.org/bottoken/sendMessage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: 100,
          text: "choose a category",
          disable_web_page_preview: true,
          reply_markup: {
            inline_keyboard: [[{ text: "Lunch", callback_data: "finops:d:draft-1:select_category:cat-1" }]]
          }
        })
      });
      return { status: "accepted", message: "ok" };
    }
  });

  const response = await dispatch(
    handler,
    request(
      "POST",
      "/telegram/webhook",
      {
        update_id: 9,
        message: {
          from: { id: 100 },
          chat: { id: 100 },
          text: "lunch 120"
        }
      },
      { "x-telegram-bot-api-secret-token": "webhook-secret" }
    )
  );

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    method: "sendMessage",
    chat_id: 100,
    text: "choose a category",
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [[{ text: "Lunch", callback_data: "finops:d:draft-1:select_category:cat-1" }]]
    }
  });
});

test("daily report endpoint requires internal token", async () => {
  const handler = createRequestHandler(baseConfig, store(), {
    generateDailyReport: async () => {
      throw new Error("should not be called");
    }
  });

  const response = await dispatch(handler, request("POST", "/internal/reports/daily", {}, { "x-internal-token": "bad" }));

  assert.equal(response.statusCode, 403);
  assert.equal(response.body.error, "forbidden");
});

test("daily report endpoint delegates with valid internal token", async () => {
  const handler = createRequestHandler(baseConfig, store(), {
    generateDailyReport: async () => ({ status: "ok", text: "report", artifactPath: "/tmp/report.md" })
  });

  const response = await dispatch(
    handler,
    request("POST", "/internal/reports/daily", {}, { "x-internal-token": "internal-token" })
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, "ok");
});

test("end-of-day spending endpoint requires internal token", async () => {
  const handler = createRequestHandler(baseConfig, store(), {
    generateEndOfDaySpendingReport: async () => {
      throw new Error("should not be called");
    }
  });

  const response = await dispatch(
    handler,
    request("POST", "/internal/reports/end-of-day-spending", {}, { "x-internal-token": "bad" })
  );

  assert.equal(response.statusCode, 403);
  assert.equal(response.body.error, "forbidden");
});

test("end-of-day spending endpoint delegates with valid internal token", async () => {
  const handler = createRequestHandler(baseConfig, store(), {
    generateEndOfDaySpendingReport: async () => ({
      status: "ok",
      text: "end-of-day report",
      artifactPath: "/tmp/end-of-day.md"
    })
  });

  const response = await dispatch(
    handler,
    request("POST", "/internal/reports/end-of-day-spending", {}, { "x-internal-token": "internal-token" })
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, "ok");
  assert.equal(response.body.artifactPath, "/tmp/end-of-day.md");
});

test("portfolio fixture sync, snapshot lookup, and aggregate endpoints persist normalized data", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "finops-app-portfolio-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));

  const portfolioStore = new PortfolioStore(join(tempDir, "portfolio.sqlite"), {
    accountIdentitySalt: "test-salt",
    writerLeaseMinutes: 1
  });
  portfolioStore.init();

  const handler = createRequestHandler(
    {
      ...baseConfig,
      portfolioDbPath: join(tempDir, "portfolio.sqlite"),
      portfolioExportDir: join(tempDir, "exports")
    },
    store(),
    { portfolioStore }
  );

  const syncResponse = await dispatch(
    handler,
    request(
      "POST",
      "/internal/portfolio/sync/fixture",
      { brokerId: "fixture", accountAlias: "fixture-main", requestedAt: nowIso(), scenario: "complete" },
      { "x-internal-token": "internal-token" }
    )
  );
  assert.equal(syncResponse.statusCode, 200);
  assert.equal(syncResponse.body.snapshot.account.accountAlias, "fixture-main");
  assert.equal(syncResponse.body.redacted.holdings, "[redacted]");

  const snapshotsResponse = await dispatch(
    handler,
    request("GET", "/internal/portfolio/snapshots?brokerId=fixture&accountAlias=fixture-main", undefined, {
      "x-internal-token": "internal-token"
    })
  );
  assert.equal(snapshotsResponse.statusCode, 200);
  assert.equal(snapshotsResponse.body.snapshot.holdings.length, 1);
  assert.equal(snapshotsResponse.body.effectiveFreshness, "fresh");

  const aggregateResponse = await dispatch(
    handler,
    request("GET", "/internal/portfolio/aggregate", undefined, { "x-internal-token": "internal-token" })
  );
  assert.equal(aggregateResponse.statusCode, 200);
  assert.equal(aggregateResponse.body.rows.length, 1);
  assert.equal(aggregateResponse.body.rows[0].symbol, "VTI");
});

test("portfolio live sync endpoint persists SinoPac connector snapshots for Wealthfolio export", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "finops-app-live-sync-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));

  const portfolioStore = new PortfolioStore(join(tempDir, "portfolio.sqlite"), {
    accountIdentitySalt: "test-salt",
    writerLeaseMinutes: 1
  });
  portfolioStore.init();

  const sinoPacLiveConnector = {
    describe: () => ({
      adapterId: "sinopac-shioaji",
      brokerId: "sinopac",
      displayName: "SinoPac Shioaji Live Read",
      kind: "live-connector",
      supportedSourceTypes: ["live-api"],
      supportedMarkets: ["TWSE"],
      supportsHoldings: true,
      supportsCash: true,
      supportsActivity: false,
      supportsCostBasis: true,
      credentialMode: "read-only-secret",
      productionStatus: "approved-read-only"
    }),
    preflight: (syncRequest) => {
      assert.equal(syncRequest.mode, "live-read");
      return { ok: true, status: "succeeded" };
    },
    syncSnapshot: async (syncRequest) => ({
      schemaVersion: "investment-portfolio.snapshot.v1",
      syncRunId: `sinopac-live-${syncRequest.accountAlias}`,
      brokerId: "sinopac",
      account: {
        brokerId: "sinopac",
        accountAlias: syncRequest.accountAlias,
        accountIdentityHash: "sinopac:tw-main",
        accountType: "tw-stock",
        baseCurrency: "TWD",
        marketScope: ["TWSE"],
        status: "active",
        createdAt: syncRequest.requestedAt,
        updatedAt: syncRequest.requestedAt
      },
      sourceType: "live-api",
      sourceFreshness: {
        sourceType: "live-api",
        sourceName: "sinopac-shioaji",
        sourceTimestamp: minutesAgoIso(60),
        fetchedAt: syncRequest.requestedAt,
        maxAgeMinutes: 1440,
        status: "fresh",
        missingFields: []
      },
      baseCurrency: "TWD",
      asOf: minutesAgoIso(60),
      holdings: [
        {
          brokerId: "sinopac",
          accountAlias: syncRequest.accountAlias,
          market: "TWSE",
          symbol: "2330",
          assetType: "stock",
          currency: "TWD",
          quantity: "10",
          costBasis: "7000",
          marketValue: "8500",
          asOf: minutesAgoIso(60),
          freshnessStatus: "fresh",
          dataQuality: []
        }
      ],
      cashBalances: [
        {
          brokerId: "sinopac",
          accountAlias: syncRequest.accountAlias,
          currency: "TWD",
          amount: "12345",
          balanceType: "available",
          asOf: minutesAgoIso(60),
          freshnessStatus: "fresh",
          dataQuality: []
        }
      ],
      activityRows: [],
      errors: [],
      dataQuality: []
    }),
    classifyError: () => "unknown"
  };

  const handler = createRequestHandler(
    {
      ...baseConfig,
      portfolioDbPath: join(tempDir, "portfolio.sqlite"),
      portfolioExportDir: join(tempDir, "exports")
    },
    store(),
    { portfolioStore, sinoPacLiveConnector }
  );

  const liveResponse = await dispatch(
    handler,
    request(
      "POST",
      "/internal/portfolio/sync/live",
      { brokerId: "sinopac", accountAlias: "tw-main", requestedAt: nowIso() },
      { "x-internal-token": "internal-token" }
    )
  );
  assert.equal(liveResponse.statusCode, 200);
  assert.equal(liveResponse.body.snapshot.sourceFreshness.sourceName, "sinopac-shioaji");

  const exportResponse = await dispatch(
    handler,
    request(
      "POST",
      "/internal/portfolio/wealthfolio/export",
      { target: "wealthfolio-local", format: "json", includePartialOrStale: true },
      { "x-internal-token": "internal-token" }
    )
  );
  const exportPayload = JSON.parse(readFileSync(exportResponse.body.artifactPath, "utf8"));
  assert.equal(exportPayload.accounts[0].brokerId, "sinopac");
  assert.equal(exportPayload.holdings[0].symbol, "2330");
  assert.equal(exportPayload.cash[0].amount, "12345");
});

test("portfolio import preview, commit, export, and purge endpoints work for manual csv flow", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "finops-app-import-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));

  const csvPath = join(tempDir, "manual.csv");
  writeFileSync(
    csvPath,
    [
      "row-type,market,symbol,currency,quantity,market-value,cost-basis,as-of",
      `holding,NASDAQ,QQQ,USD,5,2000,1500,${minutesAgoIso(60)}`
    ].join("\n")
  );

  const portfolioStore = new PortfolioStore(join(tempDir, "portfolio.sqlite"), {
    accountIdentitySalt: "test-salt",
    writerLeaseMinutes: 1
  });
  portfolioStore.init();

  const exportDir = join(tempDir, "exports");
  const handler = createRequestHandler(
    {
      ...baseConfig,
      portfolioDbPath: join(tempDir, "portfolio.sqlite"),
      portfolioExportDir: exportDir
    },
    store(),
    { portfolioStore }
  );

  const previewResponse = await dispatch(
    handler,
    request(
      "POST",
      "/internal/portfolio/import/preview",
      {
        brokerId: "manual",
        accountAlias: "manual-main",
        filePath: csvPath,
        sourceType: "manual-csv",
        requestedAt: nowIso()
      },
      { "x-internal-token": "internal-token" }
    )
  );
  assert.equal(previewResponse.statusCode, 200);
  assert.equal(previewResponse.body.preview.status, "accepted");

  const commitResponse = await dispatch(
    handler,
    request(
      "POST",
      "/internal/portfolio/import/commit",
      {
        brokerId: "manual",
        accountAlias: "manual-main",
        filePath: csvPath,
        sourceType: "manual-csv",
        requestedAt: nowIso(),
        ownerApproved: true
      },
      { "x-internal-token": "internal-token" }
    )
  );
  assert.equal(commitResponse.statusCode, 200);
  assert.equal(commitResponse.body.snapshot.account.accountAlias, "manual-main");

  const exportResponse = await dispatch(
    handler,
    request(
      "POST",
      "/internal/portfolio/wealthfolio/export",
      { target: "wealthfolio-local", format: "json", includePartialOrStale: true },
      { "x-internal-token": "internal-token" }
    )
  );
  assert.equal(exportResponse.statusCode, 200);
  assert.equal(exportResponse.body.status, "created");
  const exportPayload = JSON.parse(readFileSync(exportResponse.body.artifactPath, "utf8"));
  assert.equal(exportPayload.accounts.length, 1);
  assert.equal(exportPayload.holdings[0].symbol, "QQQ");

  portfolioStore.recordBackup("portfolio-db", join(tempDir, "portfolio.sqlite.bak"), "sha256:backup", -1);
  const purgeResponse = await dispatch(
    handler,
    request(
      "POST",
      "/internal/portfolio/maintenance/purge",
      {
        snapshotRetentionDays: 1,
        exportRetentionDays: 1,
        rawImportRetentionDays: 1,
        backupRetentionDays: 1
      },
      { "x-internal-token": "internal-token" }
    )
  );
  assert.equal(purgeResponse.statusCode, 200);
  assert.equal(purgeResponse.body.purged.backups >= 0, true);
});

test("wealthfolio export preserves partial metadata, multi-currency rows, and deduplicates repeated exports", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "finops-app-export-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));

  const portfolioStore = new PortfolioStore(join(tempDir, "portfolio.sqlite"), {
    accountIdentitySalt: "test-salt",
    writerLeaseMinutes: 1
  });
  portfolioStore.init();
  portfolioStore.persistSnapshot({
    schemaVersion: "investment-portfolio.snapshot.v1",
    syncRunId: "sync-us-fresh",
    brokerId: "fixture",
    account: {
      brokerId: "fixture",
      accountAlias: "us-main",
      accountIdentityHash: "fixture:us-main",
      baseCurrency: "USD",
      marketScope: ["NASDAQ"],
      status: "active",
      createdAt: nowIso(),
      updatedAt: nowIso()
    },
    sourceType: "live-api",
    sourceFreshness: {
      sourceType: "live-api",
      sourceName: "fixture-broker",
      sourceTimestamp: nowIso(),
      fetchedAt: nowIso(),
      committedAt: nowIso(),
      maxAgeMinutes: 1440,
      status: "fresh",
      missingFields: []
    },
    baseCurrency: "USD",
    asOf: nowIso(),
    holdings: [
      {
        brokerId: "fixture",
        accountAlias: "us-main",
        market: "NASDAQ",
        symbol: "QQQ",
        assetType: "etf",
        currency: "USD",
        quantity: "5",
        costBasis: "1500",
        marketValue: "2000",
        unrealizedPnl: "500",
        asOf: nowIso(),
        freshnessStatus: "fresh",
        dataQuality: []
      }
    ],
    cashBalances: [],
    activityRows: [],
    errors: [],
    dataQuality: []
  });
  portfolioStore.persistSnapshot({
    schemaVersion: "investment-portfolio.snapshot.v1",
    syncRunId: "sync-tw-partial",
    brokerId: "fixture",
    account: {
      brokerId: "fixture",
      accountAlias: "tw-main",
      accountIdentityHash: "fixture:tw-main",
      baseCurrency: "TWD",
      marketScope: ["TWSE"],
      status: "active",
      createdAt: nowIso(),
      updatedAt: nowIso()
    },
    sourceType: "csv-current-position-snapshot",
    sourceFreshness: {
      sourceType: "csv-current-position-snapshot",
      sourceName: "sinopac-csv",
      sourceTimestamp: nowIso(),
      fetchedAt: nowIso(),
      committedAt: nowIso(),
      maxAgeMinutes: 1440,
      status: "partial",
      missingFields: ["cashBalances", "holdings.costBasis"]
    },
    baseCurrency: "TWD",
    asOf: nowIso(),
    holdings: [
      {
        brokerId: "fixture",
        accountAlias: "tw-main",
        market: "TWSE",
        symbol: "2330",
        assetType: "equity",
        currency: "TWD",
        quantity: "10",
        marketValue: "9000",
        asOf: nowIso(),
        freshnessStatus: "partial",
        dataQuality: ["missing-cost-basis"]
      }
    ],
    cashBalances: [],
    activityRows: [],
    errors: [],
    dataQuality: ["cashBalances", "holdings.costBasis"]
  });

  const exportDir = join(tempDir, "exports");
  const handler = createRequestHandler(
    {
      ...baseConfig,
      portfolioDbPath: join(tempDir, "portfolio.sqlite"),
      portfolioExportDir: exportDir
    },
    store(),
    { portfolioStore }
  );

  const firstResponse = await dispatch(
    handler,
    request(
      "POST",
      "/internal/portfolio/wealthfolio/export",
      { target: "wealthfolio-local", format: "json", includePartialOrStale: true },
      { "x-internal-token": "internal-token" }
    )
  );
  const secondResponse = await dispatch(
    handler,
    request(
      "POST",
      "/internal/portfolio/wealthfolio/export",
      { target: "wealthfolio-local", format: "json", includePartialOrStale: true },
      { "x-internal-token": "internal-token" }
    )
  );

  assert.equal(firstResponse.statusCode, 200);
  assert.equal(secondResponse.statusCode, 200);
  assert.equal(firstResponse.body.exportId, secondResponse.body.exportId);
  assert.equal(firstResponse.body.artifactPath, secondResponse.body.artifactPath);

  const exportPayload = JSON.parse(readFileSync(firstResponse.body.artifactPath, "utf8"));
  assert.deepEqual(
    exportPayload.accounts.map((account) => account.status).sort(),
    ["fresh", "partial"]
  );
  assert.deepEqual(
    exportPayload.holdings.map((holding) => holding.currency).sort(),
    ["TWD", "USD"]
  );
});
