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

test("generates complete report when optional LLM is disabled", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "finops-report-"));
  const config = baseConfig(directory);

  const report = await generateDailyReport(config, store, async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      result: [
        {
          id: "tx1",
          type: 3,
          sourceAmount: 250000,
          sourceAccount: { name: "Cash" },
          category: { name: "Food" },
          comment: "team dinner"
        },
        {
          id: "tx2",
          type: 2,
          sourceAmount: 500000,
          sourceAccount: { name: "Bank" }
        }
      ]
    })
  }));

  assert.equal(report.status, "ok");
  assert.match(report.text, /Total spending: 2,500.00/);
  assert.match(report.text, /Total income: 5,000.00/);
  assert.match(report.text, /Net cashflow: 2,500.00/);
  assert.match(report.text, /Large expense 2,500.00 in Food/);
  assert.match(report.text, /LLM summarization disabled/);
  assert.equal(fs.existsSync(report.artifactPath), true);
});

test("marks malformed watchlist as a partial report section", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "finops-report-"));
  const config = baseConfig(directory);
  fs.writeFileSync(config.watchlistPath, "{bad json", "utf8");

  const report = await generateDailyReport(config, store, async () => ({
    ok: true,
    status: 200,
    json: async () => ({ result: [] })
  }));

  assert.equal(report.status, "partial");
  assert.match(report.text, /Watchlist \(error\)/);
});

test("keeps report generation alive when ezBookkeeping is unavailable", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "finops-report-"));
  const config = baseConfig(directory);

  const report = await generateDailyReport(config, store, async () => {
    throw new Error("network down");
  });

  assert.equal(report.status, "partial");
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

  assert.equal(report.status, "partial");
  assert.match(report.text, /FinOps Daily Report/);
});

test("adds optional LLM summary only after raw sections exist", async () => {
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
      assert.ok(body.sections.length > 0);
      return {
        ok: true,
        status: 200,
        json: async () => ({ summary: "Draft summary from source sections." })
      };
    }

    return {
      ok: true,
      status: 200,
      json: async () => ({ result: [] })
    };
  });

  assert.match(report.text, /Draft summary from source sections/);
  assert.equal(seen.some((entry) => String(entry.url).includes("llm.example.test")), true);
});

test("generates end-of-day spending report from today's expenses", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "finops-report-"));
  const config = { ...baseConfig(directory), telegramBotToken: "token", telegramReportChatId: "123" };
  const now = new Date("2026-06-04T14:30:00.000Z");
  const sameLocalDay = Math.floor(new Date("2026-06-04T04:00:00.000Z").getTime() / 1000);
  const previousLocalDay = Math.floor(new Date("2026-06-03T04:00:00.000Z").getTime() / 1000);
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
  assert.match(report.text, /FinOps End-of-Day Spending Summary/);
  assert.match(report.text, /Date: 2026-06-04/);
  assert.match(report.text, /Total spending: 460.00/);
  assert.match(report.text, /Food: 120.00/);
  assert.match(report.text, /Transport: 340.00/);
  assert.match(report.text, /Cash: 120.00/);
  assert.match(report.text, /Credit Card: 340.00/);
  assert.match(report.text, /Pending review items: 2/);
  assert.equal(fs.existsSync(report.artifactPath), true);
  assert.equal(path.basename(report.artifactPath), "end-of-day-spending-2026-06-04.md");
  assert.equal(telegramCalls.length, 1);
});

test("stores a clear end-of-day summary when no spending is recorded", async () => {
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
  assert.match(report.text, /No spending recorded for 2026-06-04/);
  assert.equal(fs.existsSync(report.artifactPath), true);
});

test("generates monthly overview with income, expense, category shares, and account movement", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "finops-report-"));
  const config = baseConfig(directory);
  const now = new Date("2026-06-04T14:30:00.000Z");
  const sameLocalMonth = Math.floor(new Date("2026-06-04T04:00:00.000Z").getTime() / 1000);
  const previousLocalMonth = Math.floor(new Date("2026-05-30T04:00:00.000Z").getTime() / 1000);

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
  assert.match(report.text, /FinOps Period Overview/);
  assert.match(report.text, /Period: This month \(2026-06\)/);
  assert.match(report.text, /Transactions: 4 \(income 1, expense 2, transfer 1\)/);
  assert.match(report.text, /Income: TWD 1,000.00/);
  assert.match(report.text, /Expenses: TWD 250.00/);
  assert.match(report.text, /Net cashflow: TWD \+750.00/);
  assert.match(report.text, /Spending \/ income: 25.0%/);
  assert.match(report.text, /Savings rate: 75.0%/);
  assert.match(report.text, /Lunch: TWD 200.00 \(80.0%\) \[##############....\]/);
  assert.match(report.text, /Transport: TWD 50.00 \(20.0%\) \[####..............\]/);
  assert.match(report.text, /Salary: TWD 1,000.00 \(100.0%\) \[##################\]/);
  assert.match(report.text, /Bank: TWD \+900.00 \(85.7%\)/);
  assert.match(report.text, /Cash: TWD -150.00 \(14.3%\)/);
  assert.doesNotMatch(report.text, /Old/);
});
