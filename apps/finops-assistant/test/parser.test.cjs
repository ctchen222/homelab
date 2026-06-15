const test = require("node:test");
const assert = require("node:assert/strict");
const { parseMessage } = require("../dist/parser.js");

test("parses a simple expense", () => {
  const result = parseMessage("expense 120 TWD food cash note lunch");
  assert.equal(result.kind, "transaction");
  assert.equal(result.transaction.type, "expense");
  assert.equal(result.transaction.amount, 120);
  assert.equal(result.transaction.currency, "TWD");
  assert.equal(result.transaction.category, "food");
  assert.equal(result.transaction.account, "cash");
  assert.equal(result.transaction.note, "lunch");
});

test("does not treat positional category and account as a note", () => {
  const result = parseMessage("expense 120 TWD food cash");

  assert.equal(result.kind, "transaction");
  assert.equal(result.transaction.category, "food");
  assert.equal(result.transaction.account, "cash");
  assert.equal(result.transaction.note, undefined);
});

test("defaults currency when omitted", () => {
  const result = parseMessage("expense 120 food cash", new Date(), {
    defaultCurrency: "TWD"
  });

  assert.equal(result.kind, "transaction");
  assert.equal(result.transaction.currency, "TWD");
  assert.equal(result.transaction.currencyDefaulted, true);
  assert.equal(result.transaction.category, "food");
  assert.equal(result.transaction.account, "cash");
});

test("uses trailing text after positional fields as the note", () => {
  const result = parseMessage("expense 120 TWD food cash lunch with team");

  assert.equal(result.kind, "transaction");
  assert.equal(result.transaction.note, "lunch with team");
});

test("parses a transfer", () => {
  const result = parseMessage("transfer 1000 TWD from bank to cash");
  assert.equal(result.kind, "transaction");
  assert.equal(result.transaction.type, "transfer");
  assert.equal(result.transaction.fromAccount, "bank");
  assert.equal(result.transaction.toAccount, "cash");
  assert.equal(result.transaction.note, undefined);
});

test("stores missing fields as ambiguous", () => {
  const result = parseMessage("expense 120 TWD");
  assert.equal(result.kind, "ambiguous");
  assert.deepEqual(result.missing, ["category", "account"]);
});

test("parses quick sentence expense", () => {
  const result = parseMessage("lunch 120", new Date("2026-06-10T12:00:00.000Z"), {
    defaultCurrency: "TWD"
  });

  assert.equal(result.kind, "quick_sentence");
  assert.equal(result.quickSentence.type, "expense");
  assert.equal(result.quickSentence.amount, 120);
  assert.equal(result.quickSentence.currency, "TWD");
  assert.equal(result.quickSentence.note, "lunch");
});

test("parses quick sentence with explicit income", () => {
  const result = parseMessage("income salary 50000", new Date("2026-06-10T12:00:00.000Z"), {
    defaultCurrency: "TWD"
  });

  assert.equal(result.kind, "quick_sentence");
  assert.equal(result.quickSentence.type, "income");
  assert.equal(result.quickSentence.amount, 50000);
});

test("parses quick sentence with explicit transfer", () => {
  const result = parseMessage("transfer 1000 savings", new Date("2026-06-10T12:00:00.000Z"), {
    defaultCurrency: "TWD"
  });

  assert.equal(result.kind, "quick_sentence");
  assert.equal(result.quickSentence.type, "transfer");
  assert.equal(result.quickSentence.amount, 1000);
  assert.equal(result.quickSentence.note, "savings");
});

test("parses quick sentence with daily date", () => {
  const result = parseMessage("coffee 80 昨天", new Date("2026-06-10T12:00:00.000Z"), {
    defaultCurrency: "TWD",
    timezone: "Asia/Taipei"
  });

  assert.equal(result.kind, "quick_sentence");
  assert.equal(result.quickSentence.note, "coffee");
  assert.equal(result.quickSentence.occurredAt, "2026-06-09T00:00:00.000+08:00");
});

test("parses quick sentence with explicit date and missing amount as ambiguous", () => {
  const result = parseMessage("coffee 2026-06-10", new Date("2026-06-12T12:00:00.000Z"), {
    defaultCurrency: "TWD",
    timezone: "Asia/Taipei"
  });

  assert.equal(result.kind, "ambiguous");
  assert.deepEqual(result.missing.includes("amount"), true);
});

test("rejects future dates in quick sentence", () => {
  const result = parseMessage("coffee 80 2030-12-31", new Date("2026-06-10T12:00:00.000Z"), {
    defaultCurrency: "TWD",
    timezone: "Asia/Taipei"
  });

  assert.equal(result.kind, "ambiguous");
  assert.deepEqual(result.missing.includes("date"), true);
});

test("parses quick sentence with explicit date", () => {
  const result = parseMessage("2026-06-10 coffee 80", new Date("2026-06-12T12:00:00.000Z"), {
    defaultCurrency: "TWD",
    timezone: "Asia/Taipei"
  });

  assert.equal(result.kind, "quick_sentence");
  assert.equal(result.quickSentence.note, "coffee");
  assert.equal(result.quickSentence.occurredAt, "2026-06-10T00:00:00.000+08:00");
});

test("parses status command", () => {
  const result = parseMessage("status");
  assert.equal(result.kind, "status");
});

test("parses cancel command", () => {
  const result = parseMessage("/cancel");
  assert.equal(result.kind, "cancel");
});

test("parses category discovery command", () => {
  const result = parseMessage("categories expense");
  assert.equal(result.kind, "categories");
  assert.equal(result.categoryType, "expense");
});

test("parses account discovery command", () => {
  const result = parseMessage("accounts");
  assert.equal(result.kind, "accounts");
});

test("parses category add command", () => {
  const result = parseMessage("category add expense public transit under Transportation alias transit");
  assert.equal(result.kind, "category_add");
  assert.equal(result.categoryType, "expense");
  assert.equal(result.name, "public transit");
  assert.equal(result.parentName, "Transportation");
  assert.equal(result.alias, "transit");
});

test("parses category confirm command", () => {
  const result = parseMessage("category confirm 123 under Transportation");
  assert.equal(result.kind, "category_confirm");
  assert.equal(result.updateId, 123);
  assert.equal(result.parentName, "Transportation");
});
