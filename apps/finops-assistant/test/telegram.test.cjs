const test = require("node:test");
const assert = require("node:assert/strict");
const { handleTelegramUpdate } = require("../dist/telegram.js");

function store(processed = new Set()) {
  const pending = [];
  const aliases = {};
  const aliasRecords = [];
  return {
    pending,
    aliases,
    isProcessed: (id) => processed.has(id),
    markProcessed: (id) => processed.add(id),
    addPendingReview: (item) => pending.push(item),
    getPendingReviewByUpdateId: (id) => pending.find((item) => item.updateId === id && !item.resolved),
    resolvePendingReview: (id) => {
      const item = pending.find((candidate) => candidate.updateId === id);
      if (item) item.resolved = true;
    },
    pendingReviewCount: () => pending.filter((item) => !item.resolved).length,
    categoryAliases: () => aliases,
    categoryAliasRecords: () => aliasRecords,
    saveCategoryAlias: (alias, categoryId, categoryType, categoryName) => {
      aliases[alias] = categoryId;
      const existing = aliasRecords.find((record) => record.alias === alias);
      if (existing) {
        existing.categoryId = categoryId;
        existing.categoryType = categoryType;
        existing.categoryName = categoryName;
      } else {
        aliasRecords.push({ alias, categoryId, categoryType, categoryName });
      }
    }
  };
}

const config = {
  telegramBotToken: "token",
  telegramAllowedUserIds: new Set([100]),
  ezBookkeepingAccountIds: {},
  ezBookkeepingCategoryIds: {},
  assistantDbPath: ":memory:",
  reportDir: "/tmp",
  watchlistPath: "/tmp/watchlist.json",
  timezone: "Asia/Taipei",
  port: 8090,
  defaultCurrency: "TWD",
  llmEnabled: false
};

const mappedConfig = {
  ...config,
  ezBookkeepingBaseUrl: "http://ezbookkeeping:8080",
  ezBookkeepingApiToken: "token",
  ezBookkeepingAccountIds: {
    cash: "account-cash"
  },
  ezBookkeepingCategoryIds: {
    food: "category-food"
  }
};

function update(id, userId, text) {
  return {
    update_id: id,
    message: {
      from: { id: userId },
      chat: { id: userId },
      text
    }
  };
}

function categoryListResponse() {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      success: true,
      result: {
        1: [
          {
            id: "parent-income",
            name: "Income",
            parentId: "0",
            type: 1,
            subCategories: [{ id: "category-salary", name: "Salary", parentId: "parent-income", type: 1 }]
          }
        ],
        2: [
          {
            id: "parent-food",
            name: "Food",
            parentId: "0",
            type: 2,
            subCategories: [{ id: "category-food", name: "Lunch", parentId: "parent-food", type: 2 }]
          }
        ],
        3: [
          {
            id: "parent-transfer",
            name: "Transfer",
            parentId: "0",
            type: 3,
            subCategories: [
              { id: "category-transfer", name: "Account Transfer", parentId: "parent-transfer", type: 3 }
            ]
          }
        ]
      }
    })
  };
}

function telegramOk(messages) {
  return async (url, init = {}) => {
    if (String(url).includes("api.telegram.org")) {
      messages?.push(JSON.parse(init.body));
    }
    return { ok: true, status: 200, json: async () => ({ success: true }) };
  };
}

test("rejects unauthorized telegram user", async () => {
  const s = store();
  const result = await handleTelegramUpdate(update(1, 200, "status"), config, s, {
    fetchImpl: async () => ({ ok: true })
  });

  assert.equal(result.status, "unauthorized");
  assert.equal(s.isProcessed(1), true);
});

test("ignores duplicate updates", async () => {
  const s = store(new Set([2]));
  const result = await handleTelegramUpdate(update(2, 100, "status"), config, s);

  assert.equal(result.status, "duplicate");
});

test("accepts authorized status request", async () => {
  const s = store();
  const result = await handleTelegramUpdate(update(6, 100, "status"), config, s, {
    fetchImpl: async () => ({ ok: true })
  });

  assert.equal(result.status, "accepted");
  assert.equal(s.isProcessed(6), true);
});

test("sends help for authorized help request", async () => {
  const s = store();
  const messages = [];
  const result = await handleTelegramUpdate(update(7, 100, "help"), config, s, {
    fetchImpl: async (_url, init = {}) => {
      messages.push(JSON.parse(init.body));
      return { ok: true };
    }
  });

  assert.equal(result.status, "accepted");
  assert.equal(s.isProcessed(7), true);
  assert.match(messages[0].text, /overview today/);
  assert.match(messages[0].text, /category add/);
});

test("sends spending overview for authorized overview request", async () => {
  const s = store();
  const overviewConfig = {
    ...config,
    ezBookkeepingBaseUrl: "http://ezbookkeeping:8080",
    ezBookkeepingApiToken: "token"
  };
  const messages = [];
  const result = await handleTelegramUpdate(update(8, 100, "overview today"), overviewConfig, s, {
    fetchImpl: async (url, init = {}) => {
      if (String(url).includes("api.telegram.org")) {
        messages.push(JSON.parse(init.body));
        return { ok: true };
      }

      return {
        ok: true,
        status: 200,
        json: async () => ({
          result: [
            {
              type: 3,
              time: Math.floor(Date.now() / 1000),
              sourceAmount: 12000,
              sourceAccount: { name: "Cash" },
              category: { name: "Food" }
            }
          ]
        })
      };
    }
  });

  assert.equal(result.status, "accepted");
  assert.equal(s.isProcessed(8), true);
  assert.match(messages[0].text, /FinOps Period Overview/);
  assert.match(messages[0].text, /Transactions: 1 \(income 0, expense 1, transfer 0\)/);
  assert.match(messages[0].text, /Expenses: TWD 120.00/);
  assert.match(messages[0].text, /Expense categories:/);
  assert.match(messages[0].text, /Food: TWD 120.00 \(100.0%\) \[##################\]/);
  assert.match(messages[0].text, /Account movement:/);
  assert.match(messages[0].text, /Cash: TWD -120.00 \(100.0%\)/);
});

test("queues ambiguous transaction for review", async () => {
  const s = store();
  const result = await handleTelegramUpdate(update(3, 100, "expense 120 TWD"), config, s, {
    fetchImpl: async () => ({ ok: true })
  });

  assert.equal(result.status, "pending_review");
  assert.equal(s.pending.length, 1);
});

test("sends category list with aliases", async () => {
  const s = store();
  const messages = [];
  const result = await handleTelegramUpdate(update(10, 100, "categories expense"), mappedConfig, s, {
    fetchImpl: async (url, init = {}) => {
      if (String(url).includes("api.telegram.org")) {
        messages.push(JSON.parse(init.body));
        return { ok: true };
      }

      assert.equal(String(url), "http://ezbookkeeping:8080/api/v1/transaction/categories/list.json?type=2");
      return categoryListResponse();
    }
  });

  assert.equal(result.status, "accepted");
  assert.match(messages[0].text, /Lunch: food/);
  assert.match(messages[0].text, /category add expense transport/);
});

test("sends account list with aliases", async () => {
  const s = store();
  const messages = [];
  const result = await handleTelegramUpdate(update(11, 100, "accounts"), mappedConfig, s, {
    fetchImpl: async (url, init = {}) => {
      if (String(url).includes("api.telegram.org")) {
        messages.push(JSON.parse(init.body));
        return { ok: true };
      }

      assert.equal(String(url), "http://ezbookkeeping:8080/api/v1/accounts/list.json");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          result: [{ id: "account-cash", name: "Local Cash", currency: "TWD" }]
        })
      };
    }
  });

  assert.equal(result.status, "accepted");
  assert.match(messages[0].text, /Local Cash \(TWD\): cash/);
});

test("adds category through Telegram and persists alias", async () => {
  const s = store();
  const messages = [];
  const result = await handleTelegramUpdate(
    update(12, 100, "category add expense transport under Transportation"),
    mappedConfig,
    s,
    {
      fetchImpl: async (url, init = {}) => {
        if (String(url).includes("api.telegram.org")) {
          messages.push(JSON.parse(init.body));
          return { ok: true };
        }

        if (String(url).includes("/list.json")) {
          return { ok: true, status: 200, json: async () => ({ success: true, result: { 2: [] } }) };
        }

        const body = JSON.parse(init.body);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            result: {
              id: body.parentId === "0" ? "parent-transport" : "category-transport",
              name: body.name,
              parentId: body.parentId,
              type: body.type
            }
          })
        };
      }
    }
  );

  assert.equal(result.status, "accepted");
  assert.equal(s.aliases.transport, "category-transport");
  assert.match(messages[0].text, /Category ready/);
});

test("records valid transaction through ezBookkeeping", async () => {
  const s = store();
  const result = await handleTelegramUpdate(update(4, 100, "expense 120 TWD food cash"), mappedConfig, s, {
    fetchImpl: async (url) => (String(url).includes("/categories/list.json") ? categoryListResponse() : { ok: true }),
    writeTransactionImpl: async () => ({ ok: true, transactionId: "tx1" })
  });

  assert.equal(result.status, "accepted");
  assert.equal(s.pending.length, 0);
});

test("records transaction with default currency through Telegram", async () => {
  const s = store();
  let seenTransaction;
  const result = await handleTelegramUpdate(update(9, 100, "expense 120 food cash"), mappedConfig, s, {
    fetchImpl: async (url) => (String(url).includes("/categories/list.json") ? categoryListResponse() : { ok: true }),
    writeTransactionImpl: async (_config, transaction) => {
      seenTransaction = transaction;
      return { ok: true, transactionId: "tx1" };
    }
  });

  assert.equal(result.status, "accepted");
  assert.equal(seenTransaction.currency, "TWD");
  assert.equal(seenTransaction.currencyDefaulted, true);
});

test("queues unknown category with confirm command", async () => {
  const s = store();
  const messages = [];
  const result = await handleTelegramUpdate(update(13, 100, "expense 120 transport cash"), mappedConfig, s, {
    fetchImpl: telegramOk(messages),
    writeTransactionImpl: async () => {
      throw new Error("should not write unknown category");
    }
  });

  assert.equal(result.status, "pending_review");
  assert.equal(s.pending.length, 1);
  assert.equal(s.pending[0].reason, "unknown_category:expense:transport");
  assert.match(messages[0].text, /category confirm 13/);
});

test("confirms unknown category and retries pending transaction", async () => {
  const s = store();
  s.addPendingReview({
    updateId: 14,
    userId: 100,
    chatId: 100,
    text: "expense 120 transport cash",
    reason: "unknown_category:expense:transport",
    payload: {
      parsed: {
        kind: "transaction",
        transaction: {
          type: "expense",
          amount: 120,
          currency: "TWD",
          category: "transport",
          account: "cash",
          occurredAt: "2026-06-04T00:00:00.000Z"
        }
      }
    }
  });
  const messages = [];
  let retriedConfig;
  const result = await handleTelegramUpdate(
    update(15, 100, "category confirm 14 under Transportation"),
    mappedConfig,
    s,
    {
      fetchImpl: async (url, init = {}) => {
        if (String(url).includes("api.telegram.org")) {
          messages.push(JSON.parse(init.body));
          return { ok: true };
        }

        if (String(url).includes("/list.json")) {
          return { ok: true, status: 200, json: async () => ({ success: true, result: { 2: [] } }) };
        }

        const body = JSON.parse(init.body);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            result: {
              id: body.parentId === "0" ? "parent-transport" : "category-transport",
              name: body.name,
              parentId: body.parentId,
              type: body.type
            }
          })
        };
      },
      writeTransactionImpl: async (retryConfig) => {
        retriedConfig = retryConfig;
        return { ok: true, transactionId: "tx2" };
      }
    }
  );

  assert.equal(result.status, "accepted");
  assert.equal(s.pending[0].resolved, true);
  assert.equal(retriedConfig.ezBookkeepingCategoryIds.transport, "category-transport");
  assert.match(messages[0].text, /pending transaction recorded/);
});

test("queues valid transaction when ezBookkeeping fails", async () => {
  const s = store();
  const result = await handleTelegramUpdate(update(5, 100, "expense 120 TWD food cash"), mappedConfig, s, {
    fetchImpl: async (url) => (String(url).includes("/categories/list.json") ? categoryListResponse() : { ok: true }),
    writeTransactionImpl: async () => ({ ok: false, error: "boom" })
  });

  assert.equal(result.status, "pending_review");
  assert.equal(s.pending.length, 1);
});
