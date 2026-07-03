const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { generateDailyReport, generateEndOfDaySpendingReport, generateSpendingOverview } = require("../dist/report.js");

function baseConfig(directory) {
  const watchlistPath = path.join(directory, "watchlist.json");
  fs.writeFileSync(
    watchlistPath,
    JSON.stringify({
      symbols: [{ market: "TWSE", ticker: "2330", displayName: "TSMC" }]
    }),
    "utf8"
  );

  return {
    port: 8090,
    telegramAllowedUserIds: new Set([100]),
    ezBookkeepingBaseUrl: "http://ezbookkeeping:8080",
    ezBookkeepingApiToken: "token",
    ezBookkeepingAccountIds: {},
    ezBookkeepingCategoryIds: {},
    defaultCurrency: "TWD",
    assistantDbPath: ":memory:",
    reportDir: directory,
    watchlistPath,
    timezone: "Asia/Taipei",
    llmEnabled: false
  };
}

const store = {
  pendingReviewCount: () => 2,
  recordReport: () => undefined
};

function unixSeconds(iso) {
  return Math.floor(new Date(iso).getTime() / 1000);
}

test("daily report leads with yesterday spending and this-month totals", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "finops-report-"));
  const config = baseConfig(directory);
  const now = new Date("2026-06-04T14:30:00.000Z");

  const report = await generateDailyReport(
    config,
    store,
    async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        result: [
          {
            id: "y-food",
            type: 3,
            time: unixSeconds("2026-06-03T04:00:00Z"),
            sourceAmount: 250000,
            sourceAccount: { name: "Cash" },
            category: { name: "Food" },
            comment: "team dinner"
          },
          {
            id: "m-income",
            type: 2,
            time: unixSeconds("2026-06-01T04:00:00Z"),
            sourceAmount: 500000,
            sourceAccount: { name: "Bank" }
          },
          {
            id: "m-transport",
            type: 3,
            time: unixSeconds("2026-06-01T04:00:00Z"),
            sourceAmount: 100000,
            sourceAccount: { name: "Cash" },
            category: { name: "Transport" }
          },
          {
            id: "old",
            type: 3,
            time: unixSeconds("2026-05-30T04:00:00Z"),
            sourceAmount: 999900,
            sourceAccount: { name: "Cash" },
            category: { name: "Old" }
          }
        ]
      })
    }),
    now
  );

  assert.equal(report.status, "ok");
  assert.match(report.text, /FinOps 日報/);
  assert.match(report.text, /昨日支出 TWD 2,500（1 筆）/);
  assert.match(report.text, /本月支出 TWD 3,500｜收入 TWD 5,000/);
  assert.match(report.text, /淨現金流 TWD \+1,500（儲蓄率 30%）/);
  assert.match(report.text, /本月支出 Top 5/);
  assert.match(report.text, /Food TWD 2,500（71%）/);
  assert.match(report.text, /Transport TWD 1,000（29%）/);
  assert.match(report.text, /昨日大額支出：Food 2,500（team dinner）/);
  assert.match(report.text, /待審核 2 筆/);
  assert.match(report.text, /觀察清單/);
  assert.match(report.text, /TWSE:2330 TSMC/);
  assert.doesNotMatch(report.text, /Old/);
  assert.doesNotMatch(report.text, /Generated:/);
  assert.equal(fs.existsSync(report.artifactPath), true);
});

test("daily report marks malformed watchlist as partial", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "finops-report-"));
  const config = baseConfig(directory);
  fs.writeFileSync(config.watchlistPath, "{bad json", "utf8");

  const report = await generateDailyReport(config, store, async () => ({
    ok: true,
    status: 200,
    json: async () => ({ result: [] })
  }));

  assert.equal(report.status, "partial");
  assert.match(report.text, /Watchlist config 無法解析/);
});

test("daily report marks bookkeeping outage as partial", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "finops-report-"));
  const config = baseConfig(directory);

  const report = await generateDailyReport(config, store, async () => {
    throw new Error("network down");
  });

  assert.equal(report.status, "partial");
  assert.match(report.text, /記帳資料暫時無法取得/);
  assert.match(report.text, /network down/);
});

test("telegram delivery failure does not fail report generation", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "finops-report-"));
  const config = { ...baseConfig(directory), telegramBotToken: "token", telegramReportChatId: "123" };

  const report = await generateDailyReport(config, store, async (url) => {
    if (String(url).includes("api.telegram.org")) {
      throw new Error("telegram down");
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ result: [] })
    };
  });

  assert.equal(report.status, "ok");
  assert.match(report.text, /FinOps 日報/);
});

test("daily report appends LLM commentary only when enabled and non-empty", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "finops-report-"));
  const config = {
    ...baseConfig(directory),
    llmEnabled: true,
    llmSummaryEndpoint: "https://llm.example.test/summary",
    llmApiKey: "llm-token"
  };
  const seen = [];

  const report = await generateDailyReport(config, store, async (url, init = {}) => {
    seen.push({ url, init });
    if (String(url).includes("llm.example.test")) {
      const body = JSON.parse(init.body);
      assert.equal(body.risk, "No broker execution. No guaranteed outcome.");
      assert.equal(typeof body.context, "string");
      return {
        ok: true,
        status: 200,
        json: async () => ({ summary: "Cashflow steady this month." })
      };
    }

    return {
      ok: true,
      status: 200,
      json: async () => ({ result: [] })
    };
  });

  assert.match(report.text, /🧠 Cashflow steady this month\./);
  assert.equal(seen.some((entry) => String(entry.url).includes("llm.example.test")), true);
});

test("daily report marks enabled LLM without configuration as partial", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "finops-report-"));
  const config = { ...baseConfig(directory), llmEnabled: true };

  const report = await generateDailyReport(config, store, async () => ({
    ok: true,
    status: 200,
    json: async () => ({ result: [] })
  }));

  assert.equal(report.status, "partial");
  assert.match(report.text, /LLM 摘要暫時無法取得/);
  assert.match(report.text, /endpoint 或 token 尚未設定/);
});

test("daily report marks LLM HTTP failure as partial", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "finops-report-"));
  const config = {
    ...baseConfig(directory),
    llmEnabled: true,
    llmSummaryEndpoint: "https://llm.example.test/summary",
    llmApiKey: "llm-token"
  };

  const report = await generateDailyReport(config, store, async (url) => {
    if (String(url).includes("llm.example.test")) {
      return { ok: false, status: 503, json: async () => ({}) };
    }

    return {
      ok: true,
      status: 200,
      json: async () => ({ result: [] })
    };
  });

  assert.equal(report.status, "partial");
  assert.match(report.text, /LLM 摘要回應 HTTP 503/);
});

test("end-of-day report summarizes today's expenses", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "finops-report-"));
  const config = { ...baseConfig(directory), telegramBotToken: "token", telegramReportChatId: "123" };
  const now = new Date("2026-06-04T14:30:00.000Z");
  const sameLocalDay = unixSeconds("2026-06-04T04:00:00Z");
  const previousLocalDay = unixSeconds("2026-06-03T04:00:00Z");
  const telegramCalls = [];

  const report = await generateEndOfDaySpendingReport(
    config,
    store,
    async (url) => {
      if (String(url).includes("api.telegram.org")) {
        telegramCalls.push(url);
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }

      return {
        ok: true,
        status: 200,
        json: async () => ({
          result: [
            {
              id: "tx1",
              type: 3,
              time: sameLocalDay,
              sourceAmount: 12000,
              sourceAccount: { name: "Cash" },
              category: { name: "Food" }
            },
            {
              id: "tx2",
              type: 3,
              time: sameLocalDay,
              sourceAmount: 34000,
              sourceAccount: { name: "Credit Card" },
              category: { name: "Transport" }
            },
            {
              id: "old",
              type: 3,
              time: previousLocalDay,
              sourceAmount: 99900,
              sourceAccount: { name: "Cash" },
              category: { name: "Old" }
            }
          ]
        })
      };
    },
    now
  );

  assert.equal(report.status, "ok");
  assert.match(report.text, /FinOps 今日支出結算/);
  assert.match(report.text, /今日支出 TWD 460（2 筆）/);
  assert.match(report.text, /Food 120/);
  assert.match(report.text, /Transport 340/);
  assert.match(report.text, /Cash 120/);
  assert.match(report.text, /Credit Card 340/);
  assert.match(report.text, /待審核 2 筆/);
  assert.doesNotMatch(report.text, /Old/);
  assert.equal(fs.existsSync(report.artifactPath), true);
  assert.equal(path.basename(report.artifactPath), "end-of-day-spending-2026-06-04.md");
  assert.equal(telegramCalls.length, 1);
});

test("end-of-day report handles a day with no spending", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "finops-report-"));
  const config = baseConfig(directory);
  const now = new Date("2026-06-04T14:30:00.000Z");

  const report = await generateEndOfDaySpendingReport(
    config,
    store,
    async () => ({
      ok: true,
      status: 200,
      json: async () => ({ result: [] })
    }),
    now
  );

  assert.equal(report.status, "partial");
  assert.match(report.text, /今日（2026-06-04）尚無支出紀錄/);
  assert.equal(fs.existsSync(report.artifactPath), true);
});

test("monthly overview reports income, expense, shares, and account movement", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "finops-report-"));
  const config = baseConfig(directory);
  const now = new Date("2026-06-04T14:30:00.000Z");
  const sameLocalMonth = unixSeconds("2026-06-04T04:00:00Z");
  const previousLocalMonth = unixSeconds("2026-05-30T04:00:00Z");

  const report = await generateSpendingOverview(
    config,
    store,
    "month",
    async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        result: [
          {
            id: "expense-lunch",
            type: 3,
            time: sameLocalMonth,
            sourceAmount: 20000,
            sourceAccount: { name: "Cash" },
            category: { name: "Lunch" }
          },
          {
            id: "expense-transport",
            type: 3,
            time: sameLocalMonth,
            sourceAmount: 5000,
            sourceAccount: { name: "Cash" },
            category: { name: "Transport" }
          },
          {
            id: "income-salary",
            type: 2,
            time: sameLocalMonth,
            sourceAmount: 100000,
            sourceAccount: { name: "Bank" },
            category: { name: "Salary" }
          },
          {
            id: "transfer-bank-to-cash",
            type: 4,
            time: sameLocalMonth,
            sourceAmount: 10000,
            destinationAmount: 10000,
            sourceAccount: { name: "Bank" },
            destinationAccount: { name: "Cash" }
          },
          {
            id: "old-expense",
            type: 3,
            time: previousLocalMonth,
            sourceAmount: 99900,
            sourceAccount: { name: "Cash" },
            category: { name: "Old" }
          }
        ]
      })
    }),
    now
  );

  assert.equal(report.status, "ok");
  assert.match(report.text, /FinOps 收支總覽/);
  assert.match(report.text, /期間：本月（2026-06）/);
  assert.match(report.text, /交易：4 筆（收入 1、支出 2、轉帳 1）/);
  assert.match(report.text, /收入：TWD 1,000/);
  assert.match(report.text, /支出：TWD 250/);
  assert.match(report.text, /淨現金流：TWD \+750（儲蓄率 75%）/);
  assert.match(report.text, /支出佔收入：25%/);
  assert.match(report.text, /Lunch：TWD 200（80%）<code>▓+░+<\/code>/);
  assert.match(report.text, /Salary：TWD 1,000（100%）/);
  assert.match(report.text, /Bank：TWD \+900（86%）/);
  assert.match(report.text, /Cash：TWD -150（14%）/);
  assert.match(report.text, /待審核 2 筆/);
  assert.doesNotMatch(report.text, /Old/);
});
