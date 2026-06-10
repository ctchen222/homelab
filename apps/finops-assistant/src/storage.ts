import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { BookkeepingCategoryType, CategoryAliasRecord, PendingReviewItem } from "./types";

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
    `);
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
