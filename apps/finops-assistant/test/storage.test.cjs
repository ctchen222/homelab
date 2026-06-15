const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { AssistantStore } = require("../dist/storage.js");

function createStore() {
  const dir = mkdtempSync(join(tmpdir(), "finops-assistant-storage-"));
  const dbPath = join(dir, "assistant.sqlite");
  const store = new AssistantStore(dbPath);
  store.init();
  return {
    dir,
    store,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function makeDraft(overrides = {}) {
  return {
    draftId: "draft-0",
    userId: 100,
    chatId: 100,
    sourceUpdateId: 1,
    type: "expense",
    currency: "TWD",
    transactionDate: "2026-06-10T00:00:00.000+08:00",
    step: "type",
    status: "active",
    ...overrides,
  };
}

test("createBookkeepingDraft cancels existing active drafts for the same user/chat", (t) => {
  const { store, cleanup } = createStore();
  t.after(() => cleanup());

  const first = makeDraft({ draftId: "draft-1", sourceUpdateId: 10 });
  const second = makeDraft({ draftId: "draft-2", sourceUpdateId: 11 });
  const third = makeDraft({ draftId: "draft-3", userId: 100, chatId: 101, sourceUpdateId: 12 });

  store.createBookkeepingDraft(first);
  store.createBookkeepingDraft(second);
  store.createBookkeepingDraft(third);

  const firstPersisted = store.getDraft(first.draftId);
  const secondPersisted = store.getDraft(second.draftId);
  const thirdPersisted = store.getDraft(third.draftId);
  const active = store.getActiveDraft(100, 100);

  assert.equal(firstPersisted?.status, "cancelled");
  assert.equal(firstPersisted?.failureReason, "replaced_by_new_draft");
  assert.equal(secondPersisted?.status, "active");
  assert.equal(active?.draftId, second.draftId);
  assert.equal(thirdPersisted?.status, "active");
  assert.equal(store.getActiveDraft(100, 101)?.draftId, third.draftId);
});
