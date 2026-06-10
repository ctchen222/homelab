const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildTransactionRequest,
  ensureTransactionCategory,
  listAccounts,
  listTransactionCategories,
  writeTransaction
} = require("../dist/ezbookkeeping.js");

const config = {
  port: 8090,
  telegramAllowedUserIds: new Set([100]),
  ezBookkeepingBaseUrl: "http://ezbookkeeping:8080",
  ezBookkeepingApiToken: "token",
  ezBookkeepingAccountIds: {
    cash: "account-cash",
    bank: "account-bank"
  },
  ezBookkeepingCategoryIds: {
    food: "category-food",
    "account transfer": "category-transfer"
  },
  assistantDbPath: ":memory:",
  reportDir: "/tmp",
  watchlistPath: "/tmp/watchlist.json",
  timezone: "Asia/Taipei",
  llmEnabled: false
};

test("builds ezBookkeeping expense request", () => {
  const body = buildTransactionRequest(config, {
    type: "expense",
    amount: 123.45,
    currency: "TWD",
    category: "food",
    account: "cash",
    occurredAt: "2026-05-22T00:00:00.000Z",
    note: "lunch"
  });

  assert.equal(body.type, 3);
  assert.equal(body.sourceAmount, 12345);
  assert.equal(body.sourceAccountId, "account-cash");
  assert.equal(body.categoryId, "category-food");
});

test("maps new category and account aliases without parser changes", () => {
  const body = buildTransactionRequest(
    {
      ...config,
      ezBookkeepingAccountIds: {
        ...config.ezBookkeepingAccountIds,
        "credit-card": "account-credit-card"
      },
      ezBookkeepingCategoryIds: {
        ...config.ezBookkeepingCategoryIds,
        medical: "category-medical"
      }
    },
    {
      type: "expense",
      amount: 450,
      currency: "TWD",
      category: "Medical",
      account: "Credit-Card",
      occurredAt: "2026-06-04T00:00:00.000Z"
    }
  );

  assert.equal(body.sourceAccountId, "account-credit-card");
  assert.equal(body.categoryId, "category-medical");
});

test("writes transaction through ezBookkeeping API", async () => {
  let request;
  const result = await writeTransaction(
    config,
    {
      type: "income",
      amount: 1000,
      currency: "TWD",
      category: "food",
      account: "cash",
      occurredAt: "2026-05-22T00:00:00.000Z"
    },
    async (url, init) => {
      request = { url, init };
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true, result: { id: "tx1" } })
      };
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.transactionId, "tx1");
  assert.equal(request.url, "http://ezbookkeeping:8080/api/v1/transactions/add.json");
  assert.equal(request.init.headers.Authorization, "Bearer token");
});

test("lists transaction categories through ezBookkeeping API", async () => {
  const categories = await listTransactionCategories(config, "expense", async (url, init) => {
    assert.equal(url, "http://ezbookkeeping:8080/api/v1/transaction/categories/list.json?type=2");
    assert.equal(init.headers.Authorization, "Bearer token");
    return {
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        result: {
          2: [
            {
              id: "parent-food",
              name: "Food",
              parentId: "0",
              type: 2,
              subCategories: [{ id: "category-lunch", name: "Lunch", parentId: "parent-food", type: 2 }]
            }
          ]
        }
      })
    };
  });

  assert.equal(categories[0].name, "Food");
  assert.equal(categories[0].subCategories[0].name, "Lunch");
});

test("lists accounts through ezBookkeeping API", async () => {
  const accounts = await listAccounts(config, async (url, init) => {
    assert.equal(url, "http://ezbookkeeping:8080/api/v1/accounts/list.json");
    assert.equal(init.headers.Authorization, "Bearer token");
    return {
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        result: [{ id: "account-cash", name: "Cash", currency: "TWD" }]
      })
    };
  });

  assert.equal(accounts[0].name, "Cash");
});

test("ensures a category by creating missing parent and leaf", async () => {
  const requests = [];
  const category = await ensureTransactionCategory(
    config,
    { categoryType: "expense", name: "transport", parentName: "Transportation" },
    async (url, init = {}) => {
      requests.push({ url, init });
      if (String(url).includes("/list.json")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, result: { 2: [] } })
        };
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
  );

  assert.equal(category.id, "category-transport");
  assert.equal(JSON.parse(requests[1].init.body).name, "Transportation");
  assert.equal(JSON.parse(requests[2].init.body).name, "Transport");
  assert.equal(JSON.parse(requests[2].init.body).parentId, "parent-transport");
});
