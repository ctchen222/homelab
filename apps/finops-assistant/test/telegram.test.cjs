const test = require("node:test");
const assert = require("node:assert/strict");
const { handleTelegramUpdate, sendTelegramMessage } = require("../dist/telegram.js");

function store(processed = new Set(), overrides = {}) {
  const pending = [];
  const aliases = {};
  const aliasRecords = [];
  const baseStore = {
    pending,
    aliases,
    aliasRecords,
  };
  return {
    pending,
    aliases,
    aliasRecords,
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
    },
    ...overrides,
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

function callbackUpdate(id, userId, data, messageId = 1) {
  return {
    update_id: id,
    callback_query: {
      id: `callback-${id}`,
      from: { id: userId },
      message: { chat: { id: userId }, message_id: messageId },
      data
    }
  };
}

function extractCallbackData(messages) {
  const values = [];
  for (const message of messages) {
    const keyboard = message?.reply_markup?.inline_keyboard;
    if (!Array.isArray(keyboard)) {
      continue;
    }
    for (const row of keyboard) {
      for (const button of row) {
        if (button && typeof button.callback_data === "string") {
          values.push(button.callback_data);
        }
      }
    }
  }
  return values;
}

function assertValidGeneratedCallbackData(values) {
  for (const value of values) {
    assert.equal(value.length <= 64, true);
    assert.match(value, /^finops:d:[^:]+:[^:]+(?::.*)?$/);
    assert.equal(value.startsWith("finops:d:d:"), false);
  }
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

test("falls back to plain Telegram text only for HTML entity parse errors", async () => {
  const calls = [];
  const result = await sendTelegramMessage(config, 100, "<b>FinOps</b> <bad>", async (_url, init = {}) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    if (calls.length === 1) {
      return {
        ok: false,
        status: 400,
        text: async () => "Bad Request: can't parse entities: Unsupported start tag \"bad\""
      };
    }
    return { ok: true, status: 200, text: async () => "" };
  });

  assert.equal(result, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].parse_mode, "HTML");
  assert.equal(calls[1].parse_mode, undefined);
  assert.equal(calls[1].text, "FinOps ");
});

test("does not hide non-HTML Telegram 400 errors with plain fallback", async () => {
  const calls = [];
  const result = await sendTelegramMessage(config, 100, "<b>FinOps</b>", async (_url, init = {}) => {
    calls.push(JSON.parse(init.body));
    return {
      ok: false,
      status: 400,
      text: async () => "Bad Request: chat not found"
    };
  });

  assert.equal(result, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].parse_mode, "HTML");
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
  assert.match(messages[0].text, /FinOps 收支總覽/);
  assert.match(messages[0].text, /交易：1 筆（收入 0、支出 1、轉帳 0）/);
  assert.match(messages[0].text, /支出：TWD 120/);
  assert.match(messages[0].text, /<b>支出分類<\/b>/);
  assert.match(messages[0].text, /Food：TWD 120（100%）<code>▓+<\/code>/);
  assert.match(messages[0].text, /<b>帳戶異動<\/b>/);
  assert.match(messages[0].text, /Cash：TWD -120（100%）/);
  assert.equal(messages[0].parse_mode, "HTML");
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
  assert.match(messages[0].text, /category confirm &lt;update_id&gt; under Transportation/);
  assert.equal(messages[0].parse_mode, "HTML");
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
  assert.match(messages[0].text, /分類已就緒/);
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
  assert.match(messages[0].text, /已建立分類.*並記錄待審交易/);
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

test("handles valid callback query and updates draft", async () => {
  const updates = new Map();
  const draft = {
    draftId: "draft-1",
    userId: 100,
    chatId: 100,
    sourceUpdateId: 1,
    type: "expense",
    amount: 120,
    currency: "TWD",
    transactionDate: "2026-06-10T00:00:00.000+08:00",
    categoryId: undefined,
    categoryName: undefined,
    accountId: "account-cash",
    accountName: "Cash",
    note: "lunch",
    step: "type",
    status: "active",
    stepForCallback: "type",
  };
  const s = store(new Set(), {
    getDraft: (draftId) => {
      if (draftId === "draft-1") return { ...draft, draftId };
    },
    updateBookkeepingDraft: (id, patch) => {
      updates.set(id, patch);
    },
  });
  const messages = [];
  const result = await handleTelegramUpdate(callbackUpdate(500, 100, "finops:d:draft-1:set_type:income"), config, s, {
    fetchImpl: async (url, init = {}) => {
      if (String(url).includes("api.telegram.org")) {
        messages.push(JSON.parse(init.body));
        return { ok: true };
      }
      return { ok: true, status: 200, json: async () => ({ success: true, result: {} }) };
    }
  });

  assert.equal(result.status, "accepted");
  assert.equal(s.isProcessed(500), true);
  assert.equal(updates.get("draft-1").type, "income");
  const callbackResponse = messages.find((item) => item.callback_query_id);
  assert.equal(callbackResponse.text, "已更新交易類型。");
  const editedMessage = messages.find((item) => item.message_id === 1);
  assert.equal(editedMessage.chat_id, 100);
});

test("rejects callback actions not valid for current draft step", async () => {
  const updates = new Map();
  const draft = {
    draftId: "draft-2",
    userId: 100,
    chatId: 100,
    sourceUpdateId: 1,
    type: "expense",
    amount: 120,
    currency: "TWD",
    transactionDate: "2026-06-10T00:00:00.000+08:00",
    categoryId: "category-food",
    note: "lunch",
    step: "amount",
    status: "active",
    accountId: "account-cash",
    accountName: "Cash",
  };
  const s = store(new Set(), {
    getDraft: (draftId) => {
      if (draftId === "draft-2") return { ...draft, draftId };
      return undefined;
    },
    updateBookkeepingDraft: (id, patch) => {
      updates.set(id, patch);
    },
  });
  const messages = [];
  const result = await handleTelegramUpdate(callbackUpdate(502, 100, "finops:d:draft-2:select_category:category-food"), config, s, {
    fetchImpl: async (_url, init = {}) => {
      if (String(_url).includes("api.telegram.org")) {
        messages.push(JSON.parse(init.body));
        return { ok: true };
      }
      return { ok: true, status: 200, json: async () => ({ success: true, result: {} }) };
    }
  });

  assert.equal(result.status, "failed");
  assert.equal(s.isProcessed(502), true);
  assert.equal(updates.size, 0);
  const callbackResponse = messages.find((item) => item.callback_query_id);
  assert.equal(callbackResponse.text, "目前畫面不支援這個操作。");
});

test("rejects malformed callback payload and replies failure", async () => {
  const s = store();
  const messages = [];
  const result = await handleTelegramUpdate(callbackUpdate(501, 100, "finops:d:draft-1"), config, s, {
    fetchImpl: async (_url, init = {}) => {
      if (String(_url).includes("api.telegram.org")) {
        messages.push(JSON.parse(init.body));
        return { ok: true };
      }
      return { ok: true };
    }
  });

  assert.equal(result.status, "failed");
  assert.equal(s.isProcessed(501), true);
  assert.equal(typeof messages[0].callback_query_id, "string");
});

test("rejects callback actions for another user's draft", async () => {
  const draft = {
    draftId: "draft-3",
    userId: 100,
    chatId: 100,
    sourceUpdateId: 1,
    type: "expense",
    amount: 120,
    currency: "TWD",
    transactionDate: "2026-06-10T00:00:00.000+08:00",
    categoryId: "category-food",
    accountId: "account-cash",
    step: "confirm",
    status: "active",
    note: "lunch",
  };
  const s = store(new Set(), {
    getDraft: (draftId) => {
      if (draftId === "draft-3") return draft;
      return undefined;
    },
  });
  const messages = [];
  const callbackInOtherChat = {
    update_id: 503,
    callback_query: {
      id: "callback-503",
      from: { id: 100 },
      message: { chat: { id: 200 }, message_id: 1 },
      data: "finops:d:draft-3:confirm",
    },
  };
  const result = await handleTelegramUpdate(callbackInOtherChat, config, s, {
    fetchImpl: async (_url, init = {}) => {
      if (String(_url).includes("api.telegram.org")) {
        messages.push(JSON.parse(init.body));
        return { ok: true };
      }
      return { ok: true, status: 200, json: async () => ({ success: true, result: {} }) };
    },
  });

  assert.equal(result.status, "unauthorized");
  assert.equal(s.isProcessed(503), true);
  const callbackResponse = messages.find((item) => item.callback_query_id);
  assert.equal(callbackResponse.text, "無法操作其他用戶的草稿。");
});

test("supports back button from date step", async () => {
  const draft = {
    draftId: "draft-date",
    userId: 100,
    chatId: 100,
    sourceUpdateId: 1,
    type: "expense",
    amount: 120,
    currency: "TWD",
    transactionDate: "2026-06-10T00:00:00.000+08:00",
    step: "date",
    status: "active",
  };
  const updates = new Map();
  const s = store(new Set(), {
    getDraft: (draftId) => {
      if (draftId === "draft-date") return draft;
      return undefined;
    },
    updateBookkeepingDraft: (id, patch) => {
      updates.set(id, patch);
      Object.assign(draft, patch);
    },
  });

  const messages = [];
  const result = await handleTelegramUpdate(
    callbackUpdate(800, 100, "finops:d:draft-date:back"),
    config,
    s,
    {
      fetchImpl: async (_url, init = {}) => {
        if (String(_url).includes("api.telegram.org")) {
          messages.push({
            url: String(_url),
            body: JSON.parse(init.body),
          });
          return { ok: true };
        }

        return { ok: true, status: 200, json: async () => ({}) };
      },
    }
  );

  assert.equal(result.status, "accepted");
  assert.equal(updates.get("draft-date").step, "amount");
  const callbackResponse = messages.find((item) => item.body.callback_query_id);
  assert.equal(callbackResponse.body.text, "已回上一步。");
});

test("uses reply-markup-only edit for category page switching", async () => {
  const draft = {
    draftId: "draft-page",
    userId: 100,
    chatId: 100,
    sourceUpdateId: 1,
    type: "expense",
    amount: 120,
    currency: "TWD",
    transactionDate: "2026-06-10T00:00:00.000+08:00",
    categoryId: undefined,
    categoryName: undefined,
    step: "category",
    status: "active",
  };
  const s = store(new Set(), {
    getDraft: (draftId) => {
      if (draftId === "draft-page") return draft;
      return undefined;
    },
    updateBookkeepingDraft: (id, patch) => {
      Object.assign(draft, patch);
    },
  });

  const calls = [];
  const categories = Array.from({ length: 8 }, (_, index) => ({
    id: `category-${index + 1}`,
    name: `Category ${index + 1}`,
    parentId: "parent-food",
    subCategories: [],
  }));
  const result = await handleTelegramUpdate(
    callbackUpdate(801, 100, "finops:d:draft-page:page_category:1"),
    config,
    s,
    {
      fetchImpl: async (_url, init = {}) => {
        if (String(_url).includes("api.telegram.org")) {
          calls.push({ url: String(_url), body: JSON.parse(init.body) });
          return { ok: true };
        }

        if (String(_url).includes("/categories/list.json")) {
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
                    subCategories: categories,
                  },
                ],
              },
            }),
          };
        }

        return { ok: true, status: 200, json: async () => ({}) };
      },
    }
  );

  const endpoint = calls.map((item) => item.url);
  assert.equal(result.status, "accepted");
  assert.equal(
    endpoint.some((url) => url.includes("editMessageReplyMarkup")),
    true,
  );
  assert.equal(
    endpoint.some((url) => url.includes("editMessageText")),
    false,
  );
  assert.equal(calls[0].body.callback_query_id.length > 0, true);
});

test("supports new category only-create without applying it to current draft", async () => {
  const updates = new Map();
  const draft = {
    draftId: "draft-only-cat",
    userId: 100,
    chatId: 100,
    sourceUpdateId: 1,
    type: "expense",
    amount: 120,
    currency: "TWD",
    transactionDate: "2026-06-10T00:00:00.000+08:00",
    step: "new_category_confirm",
    status: "active",
    createCategoryName: "transport",
    createCategoryParent: "Miscellaneous",
    createCategoryType: "expense",
  };

  const s = store(new Set(), {
    getActiveDraft: () => draft,
    getDraft: (draftId) => {
      if (draftId === "draft-only-cat") return draft;
      return undefined;
    },
    updateBookkeepingDraft: (id, patch) => {
      const previous = updates.get(id) || {};
      updates.set(id, { ...previous, ...patch });
      Object.assign(draft, patch);
    },
    saveCategoryAlias: (alias, categoryId, categoryType, categoryName) => {
      draft.alias = { alias, categoryId, categoryType, categoryName };
    },
  });

  const messages = [];
  const result = await handleTelegramUpdate(
    callbackUpdate(900, 100, "finops:d:draft-only-cat:create_category:only"),
    mappedConfig,
    s,
    {
      fetchImpl: async (url, init = {}) => {
        if (String(url).includes("api.telegram.org")) {
          messages.push(JSON.parse(init.body));
          return { ok: true };
        }

        if (String(url).includes("/transaction/categories/list.json")) {
          return { ok: true, status: 200, json: async () => ({ success: true, result: { 2: [] } }) };
        }

        if (String(url).includes("/transaction/categories/add.json")) {
          const body = JSON.parse(init.body);
          return {
            ok: true,
            status: 200,
            json: async () => ({
              success: true,
              result: {
                id: `category-created-${body.name}`,
                name: body.name,
                parentId: body.parentId,
                type: body.type,
              },
            }),
          };
        }

        return { ok: true, status: 200, json: async () => ({}) };
      },
    },
  );

  assert.equal(result.status, "accepted");
  assert.equal(s.isProcessed(900), true);
  assert.equal(draft.categoryId, undefined);
  assert.equal(draft.createCategoryName, undefined);
  assert.equal(draft.createCategoryParent, undefined);
  assert.equal(draft.createCategoryType, undefined);
  assert.equal(draft.step, "category");
  const callbackResponse = messages.find((item) => item.callback_query_id);
  assert.equal(callbackResponse.text.includes("未套用草稿"), true);
  assert.equal(draft.alias?.alias, "transport");
});

test("starts quick sentence as guided draft and renders draft prompt", async () => {
  let savedDraft;
  const s = store(new Set(), {
    getActiveDraft: () => undefined,
    createBookkeepingDraft: (draft) => {
      savedDraft = {
        ...draft,
        createdAt: "2026-06-10T00:00:00.000+08:00",
        updatedAt: "2026-06-10T00:00:00.000+08:00",
      };
    },
    getDraft: (draftId) => {
      if (savedDraft && savedDraft.draftId === draftId) {
        return savedDraft;
      }
      return undefined;
    },
  });

  const messages = [];
  const result = await handleTelegramUpdate(update(502, 100, "lunch 120"), {
    ...mappedConfig,
    timezone: "Asia/Taipei",
  }, s, {
    fetchImpl: async (url, init = {}) => {
      if (String(url).includes("api.telegram.org")) {
        messages.push(JSON.parse(init.body));
        return { ok: true };
      }

      if (String(url).includes("/categories/list.json")) {
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
                  subCategories: [{ id: "category-food", name: "Lunch", parentId: "parent-food", type: 2 }]
                }
              ]
            }
          })
        };
      }

      return { ok: true, status: 200, json: async () => ({}) };
    },
  });

  assert.equal(result.status, "accepted");
  assert.equal(savedDraft.type, "expense");
  assert.equal(savedDraft.step, "category");
  assert.equal(!!messages[0].reply_markup, true);
  assert.ok(messages[0].reply_markup.inline_keyboard.length > 0);
});

test("renders guided step keyboards with valid callback payloads under Telegram limits", async () => {
  const observedData = [];

  const amountDraft = {
    draftId: "draft-type-preview",
    userId: 100,
    chatId: 100,
    sourceUpdateId: 1,
    type: "expense",
    currency: "TWD",
    transactionDate: "2026-06-10T00:00:00.000+08:00",
    step: "amount",
    status: "active",
  };
  {
    const messages = [];
    const s = store(new Set(), {
      getActiveDraft: () => amountDraft,
      getDraft: (draftId) => (draftId === amountDraft.draftId ? amountDraft : undefined),
      updateBookkeepingDraft: (id, patch) => {
        Object.assign(amountDraft, patch);
      },
    });
    const result = await handleTelegramUpdate(
      callbackUpdate(1200, 100, `finops:d:${amountDraft.draftId}:back`),
      config,
      s,
      {
        fetchImpl: async (_url, init = {}) => {
          messages.push(JSON.parse(init.body));
          return { ok: true };
        },
      },
    );
    assert.equal(result.status, "accepted");
    const data = extractCallbackData(messages);
    observedData.push(...data);
    assert.equal(data.some((entry) => entry.includes(":set_type:")), true);
    assert.equal(data.some((entry) => entry.includes(":cancel")), true);
  }

  {
    amountDraft.step = "amount";
    const messages = [];
    const s = store(new Set(), {
      getActiveDraft: () => amountDraft,
      getDraft: (draftId) => (draftId === amountDraft.draftId ? amountDraft : undefined),
      updateBookkeepingDraft: (id, patch) => {
        Object.assign(amountDraft, patch);
      },
    });
    const result = await handleTelegramUpdate(
      callbackUpdate(1201, 100, `finops:d:${amountDraft.draftId}:set_amount`),
      config,
      s,
      {
        fetchImpl: async (_url, init = {}) => {
          messages.push(JSON.parse(init.body));
          return { ok: true };
        },
      },
    );
    assert.equal(result.status, "accepted");
    const data = extractCallbackData(messages);
    observedData.push(...data);
    assert.equal(data.some((entry) => entry.includes(":edit_type")), true);
    assert.equal(data.some((entry) => entry.includes(":back")), true);
  }

  {
    const dateDraft = {
      draftId: "draft-date-preview",
      userId: 100,
      chatId: 100,
      sourceUpdateId: 1,
      type: "expense",
      amount: 120,
      currency: "TWD",
      transactionDate: "2026-06-10T00:00:00.000+08:00",
      step: "date",
      status: "active",
    };
    const messages = [];
    const s = store(new Set(), {
      getActiveDraft: () => dateDraft,
      getDraft: (draftId) => (draftId === dateDraft.draftId ? dateDraft : undefined),
      updateBookkeepingDraft: (id, patch) => {
        Object.assign(dateDraft, patch);
      },
    });
    const result = await handleTelegramUpdate(
      callbackUpdate(1202, 100, `finops:d:${dateDraft.draftId}:set_date:custom`),
      config,
      s,
      {
        fetchImpl: async (_url, init = {}) => {
          messages.push(JSON.parse(init.body));
          return { ok: true };
        },
      },
    );
    assert.equal(result.status, "accepted");
    const data = extractCallbackData(messages);
    observedData.push(...data);
    assert.equal(data.some((entry) => entry.includes(":set_date:")), true);
    assert.equal(data.some((entry) => entry.includes(":edit_note")), true);
    assert.equal(data.some((entry) => entry.includes(":cancel")), true);
  }

  let guidedDraft;
  const guidedMessages = [];
  const guidedStore = store(new Set(), {
    getActiveDraft: () => guidedDraft,
    createBookkeepingDraft: (draft) => {
      guidedDraft = {
        ...draft,
        createdAt: "2026-06-10T00:00:00.000+08:00",
        updatedAt: "2026-06-10T00:00:00.000+08:00",
      };
    },
    getDraft: (draftId) => (guidedDraft && guidedDraft.draftId === draftId ? guidedDraft : undefined),
    updateBookkeepingDraft: (id, patch) => {
      if (guidedDraft && guidedDraft.draftId === id) {
        Object.assign(guidedDraft, patch);
      }
    },
  });

  const startResult = await handleTelegramUpdate(update(1203, 100, "lunch 120"), {
    ...mappedConfig,
    timezone: "Asia/Taipei",
  }, guidedStore, {
    fetchImpl: async (url, init = {}) => {
      if (String(url).includes("api.telegram.org")) {
        guidedMessages.push(JSON.parse(init.body));
        return { ok: true };
      }

      if (String(url).includes("/categories/list.json")) {
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
                  subCategories: [{ id: "category-food", name: "Lunch", parentId: "parent-food", type: 2 }],
                },
              ],
            },
          }),
        };
      }

      if (String(url).includes("/accounts/list.json")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, result: [{ id: "account-cash", name: "Local Cash", currency: "TWD" }] }),
        };
      }

      return { ok: true, status: 200, json: async () => ({}) };
    },
  });
  assert.equal(startResult.status, "accepted");
  const categoryButtons = extractCallbackData(guidedMessages.slice(-1));
  observedData.push(...categoryButtons);
  assert.equal(categoryButtons.some((entry) => entry.includes(":select_category:category-food")), true);
  assert.equal(categoryButtons.some((entry) => entry.endsWith(":new_category")), true);

  const selectCategory = await handleTelegramUpdate(
    callbackUpdate(1204, 100, `finops:d:${guidedDraft.draftId}:select_category:category-food`, 1),
    mappedConfig,
    guidedStore,
    {
      fetchImpl: async (_url, init = {}) => {
        if (String(_url).includes("api.telegram.org")) {
          guidedMessages.push(JSON.parse(init.body));
          return { ok: true };
        }
        if (String(_url).includes("/accounts/list.json")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ success: true, result: [{ id: "account-cash", name: "Local Cash", currency: "TWD" }] }),
          };
        }
        return { ok: true, status: 200, json: async () => ({}) };
      },
    },
  );
  assert.equal(selectCategory.status, "accepted");
  const accountButtons = extractCallbackData(guidedMessages.slice(-1));
  observedData.push(...accountButtons);
  assert.equal(accountButtons.some((entry) => entry.includes(":select_account:")), true);

  const enterAccount = await handleTelegramUpdate(
    update(1205, 100, "cash"),
    mappedConfig,
    guidedStore,
    {
      fetchImpl: async (url, init = {}) => {
        if (String(url).includes("api.telegram.org")) {
          guidedMessages.push(JSON.parse(init.body));
          return { ok: true };
        }

        if (String(url).includes("/accounts/list.json")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ success: true, result: [{ id: "account-cash", name: "Local Cash", currency: "TWD" }] }),
          };
        }

        return { ok: true, status: 200, json: async () => ({}) };
      },
    },
  );
  assert.equal(enterAccount.status, "accepted");
  const noteButtons = extractCallbackData(guidedMessages.slice(-1));
  observedData.push(...noteButtons);
  assert.equal(noteButtons.some((entry) => entry.includes(":edit_category")), true);

  const enterNote = await handleTelegramUpdate(
    update(1206, 100, "晚餐"),
    mappedConfig,
    guidedStore,
    {
      fetchImpl: async (_url, init = {}) => {
        if (String(_url).includes("api.telegram.org")) {
          guidedMessages.push(JSON.parse(init.body));
          return { ok: true };
        }
        return { ok: true, status: 200, json: async () => ({}) };
      },
    },
  );
  assert.equal(enterNote.status, "accepted");
  const confirmButtons = extractCallbackData(guidedMessages.slice(-1));
  observedData.push(...confirmButtons);
  assert.equal(confirmButtons.some((entry) => entry.includes(":confirm")), true);
  assert.equal(confirmButtons.some((entry) => entry.includes(":edit_type")), true);

  let newCategoryDraft;
  const newCategoryMessages = [];
  const newCategoryStore = store(new Set(), {
    getActiveDraft: () => newCategoryDraft,
    createBookkeepingDraft: (draft) => {
      newCategoryDraft = {
        ...draft,
        createdAt: "2026-06-10T00:00:00.000+08:00",
        updatedAt: "2026-06-10T00:00:00.000+08:00",
      };
    },
    getDraft: (draftId) => (newCategoryDraft && newCategoryDraft.draftId === draftId ? newCategoryDraft : undefined),
    updateBookkeepingDraft: (id, patch) => {
      if (newCategoryDraft && newCategoryDraft.draftId === id) {
        Object.assign(newCategoryDraft, patch);
      }
    },
  });

  const newCategoryStart = await handleTelegramUpdate(update(1207, 100, "taxi 120"), {
    ...mappedConfig,
    timezone: "Asia/Taipei",
  }, newCategoryStore, {
    fetchImpl: async (url, init = {}) => {
      if (String(url).includes("api.telegram.org")) {
        newCategoryMessages.push(JSON.parse(init.body));
        return { ok: true };
      }

      if (String(url).includes("/categories/list.json")) {
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
                  subCategories: [{ id: "category-food", name: "Lunch", parentId: "parent-food", type: 2 }],
                },
              ],
            },
          }),
        };
      }

      return { ok: true, status: 200, json: async () => ({}) };
    },
  });
  assert.equal(newCategoryStart.status, "accepted");
  const newCategoryStartButtons = extractCallbackData(newCategoryMessages.slice(-1));
  observedData.push(...newCategoryStartButtons);

  const openNewCategory = await handleTelegramUpdate(
    callbackUpdate(1208, 100, `finops:d:${newCategoryDraft.draftId}:new_category`),
    mappedConfig,
    newCategoryStore,
    {
      fetchImpl: async (_url, init = {}) => {
        if (String(_url).includes("api.telegram.org")) {
          newCategoryMessages.push(JSON.parse(init.body));
          return { ok: true };
        }
        return { ok: true, status: 200, json: async () => ({}) };
      },
    },
  );
  assert.equal(openNewCategory.status, "accepted");
  const newCategoryNameButtons = extractCallbackData(newCategoryMessages.slice(-1));
  observedData.push(...newCategoryNameButtons);
  assert.equal(newCategoryNameButtons.some((entry) => entry.includes(":cancel")), true);

  const newCategoryName = await handleTelegramUpdate(update(1209, 100, "transport"), mappedConfig, newCategoryStore, {
    fetchImpl: async (_url, init = {}) => {
      if (String(_url).includes("api.telegram.org")) {
        newCategoryMessages.push(JSON.parse(init.body));
        return { ok: true };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    },
  });
  assert.equal(newCategoryName.status, "accepted");
  const parentButtons = extractCallbackData(newCategoryMessages.slice(-1));
  observedData.push(...parentButtons);
  assert.equal(parentButtons.some((entry) => entry.includes(":new_category_confirm")), true);

  const openCategoryConfirm = await handleTelegramUpdate(
    callbackUpdate(1210, 100, `finops:d:${newCategoryDraft.draftId}:new_category_confirm`),
    mappedConfig,
    newCategoryStore,
    {
      fetchImpl: async (_url, init = {}) => {
        if (String(_url).includes("api.telegram.org")) {
          newCategoryMessages.push(JSON.parse(init.body));
          return { ok: true };
        }
        return { ok: true, status: 200, json: async () => ({}) };
      },
    },
  );
  assert.equal(openCategoryConfirm.status, "accepted");
  const confirmCreateButtons = extractCallbackData(newCategoryMessages.slice(-1));
  observedData.push(...confirmCreateButtons);
  assert.equal(confirmCreateButtons.some((entry) => entry.includes(":create_category:confirm")), true);
  assert.equal(confirmCreateButtons.some((entry) => entry.includes(":create_category:only")), true);

  assertValidGeneratedCallbackData(observedData);
});

test("cancels active draft via /cancel command", async () => {
  const draft = {
    draftId: "draft-cancel-1",
    userId: 100,
    chatId: 100,
    sourceUpdateId: 1,
    type: "expense",
    amount: 120,
    currency: "TWD",
    transactionDate: "2026-06-10T00:00:00.000+08:00",
    categoryId: "category-food",
    accountId: "account-cash",
    step: "confirm",
    status: "active",
  };

  let cancelled = false;
  const s = store(new Set(), {
    getActiveDraft: () => draft,
    cancelBookkeepingDraft: () => {
      cancelled = true;
    },
  });
  const messages = [];

  const result = await handleTelegramUpdate(update(600, 100, "/cancel"), config, s, {
    fetchImpl: async (_url, init = {}) => {
      if (String(_url).includes("api.telegram.org")) {
        messages.push(JSON.parse(init.body));
        return { ok: true };
      }

      return { ok: true };
    },
  });

  assert.equal(result.status, "accepted");
  assert.equal(cancelled, true);
  assert.equal(s.isProcessed(600), true);
  assert.equal(messages[0].text, "已取消目前草稿。");
});

test("does not duplicate transaction when confirm callback is retried", async () => {
  const draft = {
    draftId: "draft-confirm-dup",
    userId: 100,
    chatId: 100,
    sourceUpdateId: 1,
    type: "expense",
    amount: 120,
    currency: "TWD",
    transactionDate: "2026-06-10T00:00:00.000+08:00",
    categoryId: "category-food",
    accountId: "account-cash",
    step: "confirm",
    status: "active",
    note: "lunch",
  };

  let writes = 0;
  const s = store(new Set(), {
    getDraft: () => draft,
    updateBookkeepingDraft: (id, patch) => {
      if (id === "draft-confirm-dup") {
        Object.assign(draft, patch);
      }
    },
    confirmBookkeepingDraft: (id, txId) => {
      if (id === "draft-confirm-dup") {
        draft.status = "confirmed";
        draft.writeTransactionId = txId;
      }
    },
  });

  const messages = [];
  const callback = callbackUpdate(700, 100, "finops:d:draft-confirm-dup:confirm");
  const writeTransactionImpl = async () => {
    writes += 1;
    return { ok: true, transactionId: "tx-1" };
  };

  const first = await handleTelegramUpdate(callback, mappedConfig, s, {
    fetchImpl: async (_url, init = {}) => {
      if (String(_url).includes("api.telegram.org")) {
        messages.push(JSON.parse(init.body));
      }
      return { ok: true, status: 200, json: async () => ({}) };
    },
    writeTransactionImpl,
  });

  const second = await handleTelegramUpdate({
    ...callback,
    update_id: 701,
  }, mappedConfig, s, {
    fetchImpl: async (_url, init = {}) => {
      if (String(_url).includes("api.telegram.org")) {
        messages.push(JSON.parse(init.body));
      }
      return { ok: true, status: 200, json: async () => ({}) };
    },
    writeTransactionImpl,
  });

  assert.equal(first.status, "accepted");
  assert.equal(second.status, "failed");
  assert.equal(writes, 1);
  assert.equal(messages.filter((item) => item.callback_query_id).length, 2);
  assert.equal(s.isProcessed(700), true);
  assert.equal(s.isProcessed(701), true);
  const failureNotice = messages.find(
    (item) =>
      item.callback_query_id &&
      (item.text.includes("已處理") || item.text.includes("已失效")),
  );
  assert.equal(failureNotice !== undefined, true);
});
