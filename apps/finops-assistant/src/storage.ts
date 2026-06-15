import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  BookkeepingCategoryType,
  BookkeepingDraft,
  BookkeepingDraftStep,
  CategoryAliasRecord,
  PendingReviewItem,
} from "./types";

const BOOKKEEPING_DRAFT_COLUMN_MAP: Record<string, string> = {
  type: "type",
  amount: "amount",
  currency: "currency",
  transactionDate: "transaction_date",
  categoryId: "category_id",
  categoryName: "category_name",
  categoryAlias: "category_alias",
  accountId: "account_id",
  accountName: "account_name",
  accountAlias: "account_alias",
  fromAccountId: "from_account_id",
  fromAccountName: "from_account_name",
  toAccountId: "to_account_id",
  toAccountName: "to_account_name",
  note: "note",
  step: "step",
  status: "status",
  writeTransactionId: "write_transaction_id",
  failureReason: "failure_reason",
  createCategoryName: "create_category_name",
  createCategoryParent: "create_category_parent",
  createCategoryType: "create_category_type",
};

function quote(value: string): string {
  if (value.length > 100_000) {
    throw new Error("value too large for sqlite write");
  }
  return `'${value.replace(/'/g, "''")}'`;
}

function numberLiteral(value: number): string {
  if (!Number.isSafeInteger(value)) {
    throw new Error("expected safe integer");
  }
  return String(value);
}

function maybeQuote(value: string | undefined): string {
  return value ? quote(value) : "NULL";
}

function maybeNumber(value: number | undefined): string {
  return value === undefined ? "NULL" : String(value);
}

export class AssistantStore {
  constructor(private readonly dbPath: string) {}

  init(): void {
    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.run(`
      CREATE TABLE IF NOT EXISTS processed_updates (
        update_id INTEGER PRIMARY KEY,
        handled_at TEXT NOT NULL,
        outcome TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pending_reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        update_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        chat_id INTEGER NOT NULL,
        text TEXT NOT NULL,
        reason TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );
      CREATE TABLE IF NOT EXISTS report_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        report_type TEXT NOT NULL,
        status TEXT NOT NULL,
        artifact_path TEXT,
        summary TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS category_aliases (
        alias TEXT PRIMARY KEY,
        category_id TEXT NOT NULL,
        category_type TEXT NOT NULL,
        category_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS bookkeeping_drafts (
        draft_id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        chat_id INTEGER NOT NULL,
        source_update_id INTEGER NOT NULL,
        type TEXT NOT NULL,
        amount REAL,
        currency TEXT,
        transaction_date TEXT NOT NULL,
        category_id TEXT,
        category_name TEXT,
        category_alias TEXT,
        account_id TEXT,
        account_name TEXT,
        account_alias TEXT,
        from_account_id TEXT,
        from_account_name TEXT,
        to_account_id TEXT,
        to_account_name TEXT,
        note TEXT,
        step TEXT NOT NULL,
        status TEXT NOT NULL,
        write_transaction_id TEXT,
        failure_reason TEXT,
        create_category_name TEXT,
        create_category_parent TEXT,
        create_category_type TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
    `);
  }

  createBookkeepingDraft(draft: Omit<BookkeepingDraft, "createdAt" | "updatedAt" | "expiresAt"> & { expiresAt?: string }): string {
    const now = new Date().toISOString();
    const createdAt = now;
    const updatedAt = now;
    const expiresAt = draft.expiresAt || now;

    this.run(`
      UPDATE bookkeeping_drafts
      SET status = 'cancelled',
          failure_reason = 'replaced_by_new_draft',
          step = 'type',
          updated_at = ${quote(updatedAt)}
      WHERE user_id = ${numberLiteral(draft.userId)}
        AND chat_id = ${numberLiteral(draft.chatId)}
        AND status = 'active'
        AND draft_id != ${quote(draft.draftId)};
    `);

    this.run(`
      INSERT INTO bookkeeping_drafts (
        draft_id,
        user_id,
        chat_id,
        source_update_id,
        type,
        amount,
        currency,
        transaction_date,
        category_id,
        category_name,
        category_alias,
        account_id,
        account_name,
        account_alias,
        from_account_id,
        from_account_name,
        to_account_id,
        to_account_name,
        note,
        step,
        status,
        write_transaction_id,
        failure_reason,
        create_category_name,
        create_category_parent,
        create_category_type,
        created_at,
        updated_at,
        expires_at
      ) VALUES (
        ${quote(draft.draftId)},
        ${numberLiteral(draft.userId)},
        ${numberLiteral(draft.chatId)},
        ${numberLiteral(draft.sourceUpdateId)},
        ${quote(draft.type)},
        ${maybeNumber(draft.amount)},
        ${maybeQuote(draft.currency)},
        ${quote(draft.transactionDate)},
        ${maybeQuote(draft.categoryId)},
        ${maybeQuote(draft.categoryName)},
        ${maybeQuote(draft.categoryAlias)},
        ${maybeQuote(draft.accountId)},
        ${maybeQuote(draft.accountName)},
        ${maybeQuote(draft.accountAlias)},
        ${maybeQuote(draft.fromAccountId)},
        ${maybeQuote(draft.fromAccountName)},
        ${maybeQuote(draft.toAccountId)},
        ${maybeQuote(draft.toAccountName)},
        ${maybeQuote(draft.note)},
        ${quote(draft.step)},
        ${quote(draft.status)},
        ${maybeQuote(draft.writeTransactionId)},
        ${maybeQuote(draft.failureReason)},
        ${maybeQuote(draft.createCategoryName)},
        ${maybeQuote(draft.createCategoryParent)},
        ${maybeQuote(draft.createCategoryType)},
        ${quote(createdAt)},
        ${quote(updatedAt)},
        ${quote(expiresAt)}
      );
    `);
    return draft.draftId;
  }

  getActiveDraft(userId: number, chatId: number): BookkeepingDraft | undefined {
    const line = this.queryLines(`
      SELECT
        draft_id || char(9) ||
        user_id || char(9) ||
        chat_id || char(9) ||
        source_update_id || char(9) ||
        type || char(9) ||
        ifnull(amount, '') || char(9) ||
        ifnull(currency, '') || char(9) ||
        transaction_date || char(9) ||
        ifnull(category_id, '') || char(9) ||
        ifnull(category_name, '') || char(9) ||
        ifnull(category_alias, '') || char(9) ||
        ifnull(account_id, '') || char(9) ||
        ifnull(account_name, '') || char(9) ||
        ifnull(account_alias, '') || char(9) ||
        ifnull(from_account_id, '') || char(9) ||
        ifnull(from_account_name, '') || char(9) ||
        ifnull(to_account_id, '') || char(9) ||
        ifnull(to_account_name, '') || char(9) ||
        ifnull(note, '') || char(9) ||
        step || char(9) ||
        status || char(9) ||
        ifnull(write_transaction_id, '') || char(9) ||
        ifnull(failure_reason, '') || char(9) ||
        ifnull(create_category_name, '') || char(9) ||
        ifnull(create_category_parent, '') || char(9) ||
        ifnull(create_category_type, '') || char(9) ||
        created_at || char(9) ||
        updated_at || char(9) ||
        expires_at
      FROM bookkeeping_drafts
      WHERE user_id = ${numberLiteral(userId)}
        AND chat_id = ${numberLiteral(chatId)}
        AND status = 'active'
      ORDER BY created_at DESC
      LIMIT 1;
    `)[0];
    if (!line) return undefined;

    return this.parseBookkeepingDraft(line);
  }

  getDraft(draftId: string): BookkeepingDraft | undefined {
    const line = this.queryLines(`
      SELECT
        draft_id || char(9) ||
        user_id || char(9) ||
        chat_id || char(9) ||
        source_update_id || char(9) ||
        type || char(9) ||
        ifnull(amount, '') || char(9) ||
        ifnull(currency, '') || char(9) ||
        transaction_date || char(9) ||
        ifnull(category_id, '') || char(9) ||
        ifnull(category_name, '') || char(9) ||
        ifnull(category_alias, '') || char(9) ||
        ifnull(account_id, '') || char(9) ||
        ifnull(account_name, '') || char(9) ||
        ifnull(account_alias, '') || char(9) ||
        ifnull(from_account_id, '') || char(9) ||
        ifnull(from_account_name, '') || char(9) ||
        ifnull(to_account_id, '') || char(9) ||
        ifnull(to_account_name, '') || char(9) ||
        ifnull(note, '') || char(9) ||
        step || char(9) ||
        status || char(9) ||
        ifnull(write_transaction_id, '') || char(9) ||
        ifnull(failure_reason, '') || char(9) ||
        ifnull(create_category_name, '') || char(9) ||
        ifnull(create_category_parent, '') || char(9) ||
        ifnull(create_category_type, '') || char(9) ||
        created_at || char(9) ||
        updated_at || char(9) ||
        expires_at
      FROM bookkeeping_drafts
      WHERE draft_id = ${quote(draftId)}
      LIMIT 1;
    `)[0];
    if (!line) return undefined;

    return this.parseBookkeepingDraft(line);
  }

  updateBookkeepingDraft(
    draftId: string,
    patch: Partial<
      Omit<
        BookkeepingDraft,
        "draftId" | "userId" | "chatId" | "sourceUpdateId" | "createdAt"
      >
    >,
  ): void {
    const now = new Date().toISOString();
    const sets: string[] = [`updated_at=${quote(now)}`];

    for (const [key, value] of Object.entries(patch)) {
      const mapped = BOOKKEEPING_DRAFT_COLUMN_MAP[key as keyof typeof BOOKKEEPING_DRAFT_COLUMN_MAP];
      if (!mapped) continue;
      if (typeof value === "undefined") {
        sets.push(`${mapped}=NULL`);
      } else if (key === "amount" && typeof value === "number") {
        sets.push(`amount=${value}`);
      } else if (key === "transactionDate" || key === "expiresAt" || key === "createdAt" || key === "updatedAt") {
        continue;
      } else {
        sets.push(`${mapped}=${quote(String(value))}`);
      }
    }

    if (sets.length === 0) return;

    this.run(`
      UPDATE bookkeeping_drafts
      SET ${sets.join(", ")}
      WHERE draft_id = ${quote(draftId)};
    `);
  }

  cancelBookkeepingDraft(draftId: string, reason?: string): void {
    this.updateBookkeepingDraft(draftId, {
      status: "cancelled",
      failureReason: reason,
      step: "type",
    });
  }

  failBookkeepingDraft(draftId: string, reason: string): void {
    this.updateBookkeepingDraft(draftId, {
      status: "failed",
      failureReason: reason,
      step: "confirm",
    });
  }

  confirmBookkeepingDraft(draftId: string, writeTransactionId: string): void {
    this.updateBookkeepingDraft(draftId, {
      status: "confirmed",
      writeTransactionId,
      step: "confirm",
    });
  }

  expireOutdatedDrafts(isoNow: string = new Date().toISOString()): number {
    const raw = this.queryScalar(`
      SELECT COUNT(1) FROM bookkeeping_drafts
      WHERE status = 'active' AND datetime(expires_at) < datetime(${quote(isoNow)})
    `);
    const count = Number.parseInt(raw || "0", 10);
    this.run(`
      UPDATE bookkeeping_drafts
      SET status = 'expired', step = 'type', updated_at = ${quote(isoNow)}
      WHERE status = 'active' AND datetime(expires_at) < datetime(${quote(isoNow)})
    `);
    return count;
  }

  private parseBookkeepingDraft(raw: string): BookkeepingDraft {
    const [
      draftId,
      userId,
      chatId,
      sourceUpdateId,
      type,
      rawAmount,
      currency,
      transactionDate,
      categoryId,
      categoryName,
      categoryAlias,
      accountId,
      accountName,
      accountAlias,
      fromAccountId,
      fromAccountName,
      toAccountId,
      toAccountName,
      note,
      step,
      status,
      writeTransactionId,
      failureReason,
      createCategoryName,
      createCategoryParent,
      createCategoryType,
      createdAt,
      updatedAt,
      expiresAt,
    ] = raw.split("\t");

    return {
      draftId,
      userId: Number.parseInt(userId, 10),
      chatId: Number.parseInt(chatId, 10),
      sourceUpdateId: Number.parseInt(sourceUpdateId, 10),
      type: type as BookkeepingDraft["type"],
      amount: rawAmount === "" ? undefined : Number.parseFloat(rawAmount),
      currency: currency || undefined,
      transactionDate,
      categoryId: categoryId || undefined,
      categoryName: categoryName || undefined,
      categoryAlias: categoryAlias || undefined,
      accountId: accountId || undefined,
      accountName: accountName || undefined,
      accountAlias: accountAlias || undefined,
      fromAccountId: fromAccountId || undefined,
      fromAccountName: fromAccountName || undefined,
      toAccountId: toAccountId || undefined,
      toAccountName: toAccountName || undefined,
      note: note || undefined,
      step: step as BookkeepingDraftStep,
      status: status as BookkeepingDraft["status"],
      writeTransactionId: writeTransactionId || undefined,
      failureReason: failureReason || undefined,
      createCategoryName: createCategoryName || undefined,
      createCategoryParent: createCategoryParent || undefined,
      createCategoryType: createCategoryType as BookkeepingDraft["createCategoryType"],
      createdAt,
      updatedAt,
      expiresAt,
    };
  }

  isProcessed(updateId: number): boolean {
    const value = this.queryScalar(
      `SELECT COUNT(1) FROM processed_updates WHERE update_id = ${numberLiteral(updateId)};`
    );
    return value === "1";
  }

  markProcessed(updateId: number, outcome: string): void {
    this.run(`
      INSERT OR REPLACE INTO processed_updates (update_id, handled_at, outcome)
      VALUES (${numberLiteral(updateId)}, ${quote(new Date().toISOString())}, ${quote(outcome)});
    `);
  }

  addPendingReview(item: PendingReviewItem): void {
    this.run(`
      INSERT INTO pending_reviews (update_id, user_id, chat_id, text, reason, payload_json, created_at)
      VALUES (
        ${numberLiteral(item.updateId)},
        ${numberLiteral(item.userId)},
        ${numberLiteral(item.chatId)},
        ${quote(item.text)},
        ${quote(item.reason)},
        ${quote(JSON.stringify(item.payload))},
        ${quote(new Date().toISOString())}
      );
    `);
  }

  getPendingReviewByUpdateId(updateId: number): PendingReviewItem | undefined {
    const line = this.queryLines(`
      SELECT update_id || char(9) || user_id || char(9) || chat_id || char(9) || text || char(9) || reason || char(9) || payload_json
      FROM pending_reviews
      WHERE update_id = ${numberLiteral(updateId)} AND resolved_at IS NULL
      ORDER BY id DESC
      LIMIT 1;
    `)[0];
    if (!line) return undefined;

    const [rawUpdateId, rawUserId, rawChatId, text, reason, payloadJson] = line.split("\t");
    return {
      updateId: Number.parseInt(rawUpdateId, 10),
      userId: Number.parseInt(rawUserId, 10),
      chatId: Number.parseInt(rawChatId, 10),
      text,
      reason,
      payload: JSON.parse(payloadJson),
    };
  }

  resolvePendingReview(updateId: number): void {
    this.run(`
      UPDATE pending_reviews
      SET resolved_at = ${quote(new Date().toISOString())}
      WHERE update_id = ${numberLiteral(updateId)} AND resolved_at IS NULL;
    `);
  }

  pendingReviewCount(): number {
    const value = this.queryScalar("SELECT COUNT(1) FROM pending_reviews WHERE resolved_at IS NULL;");
    return Number.parseInt(value || "0", 10);
  }

  recordReport(reportType: string, status: string, summary: string, artifactPath?: string): void {
    this.run(`
      INSERT INTO report_history (report_type, status, artifact_path, summary, created_at)
      VALUES (
        ${quote(reportType)},
        ${quote(status)},
        ${artifactPath ? quote(artifactPath) : "NULL"},
        ${quote(summary)},
        ${quote(new Date().toISOString())}
      );
    `);
  }

  categoryAliases(): Record<string, string> {
    const aliases: Record<string, string> = {};
    for (const line of this.queryLines("SELECT alias || char(9) || category_id FROM category_aliases ORDER BY alias;")) {
      const [alias, categoryId] = line.split("\t");
      if (alias && categoryId) aliases[alias] = categoryId;
    }
    return aliases;
  }

  categoryAliasRecords(): CategoryAliasRecord[] {
    return this.queryLines(
      "SELECT alias || char(9) || category_id || char(9) || category_type || char(9) || category_name FROM category_aliases ORDER BY alias;",
    ).map((line) => {
      const [alias, categoryId, categoryType, categoryName] = line.split("\t");
      return {
        alias,
        categoryId,
        categoryType: categoryType as BookkeepingCategoryType,
        categoryName,
      };
    });
  }

  saveCategoryAlias(alias: string, categoryId: string, categoryType: BookkeepingCategoryType, categoryName: string): void {
    const now = new Date().toISOString();
    this.run(`
      INSERT INTO category_aliases (alias, category_id, category_type, category_name, created_at, updated_at)
      VALUES (${quote(alias.toLowerCase())}, ${quote(categoryId)}, ${quote(categoryType)}, ${quote(categoryName)}, ${quote(now)}, ${quote(now)})
      ON CONFLICT(alias) DO UPDATE SET
        category_id = excluded.category_id,
        category_type = excluded.category_type,
        category_name = excluded.category_name,
        updated_at = excluded.updated_at;
    `);
  }

  private run(sql: string): void {
    execFileSync("sqlite3", [this.dbPath, sql], { stdio: "pipe" });
  }

  private queryScalar(sql: string): string {
    return String(execFileSync("sqlite3", [this.dbPath, sql], { encoding: "utf8" })).trim();
  }

  private queryLines(sql: string): string[] {
    const output = String(execFileSync("sqlite3", [this.dbPath, sql], { encoding: "utf8" })).trim();
      return output ? output.split("\n") : [];
    }
}
