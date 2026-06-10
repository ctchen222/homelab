export type TransactionType = "expense" | "income" | "transfer";
export type SpendingOverviewPeriod = "today" | "month" | "7d";
export type BookkeepingCategoryType = "income" | "expense" | "transfer";

export interface ParsedTransaction {
  type: TransactionType;
  amount: number;
  currency: string;
  currencyDefaulted?: boolean;
  category?: string;
  account?: string;
  accountDefaulted?: boolean;
  fromAccount?: string;
  toAccount?: string;
  note?: string;
  occurredAt: string;
}

export type ParsedMessage =
  | { kind: "transaction"; transaction: ParsedTransaction }
  | { kind: "status" }
  | { kind: "help" }
  | { kind: "overview"; period: SpendingOverviewPeriod }
  | { kind: "categories"; categoryType?: BookkeepingCategoryType }
  | { kind: "accounts" }
  | {
      kind: "category_add";
      categoryType: BookkeepingCategoryType;
      name: string;
      parentName?: string;
      alias?: string;
    }
  | {
      kind: "category_confirm";
      updateId: number;
      parentName?: string;
      alias?: string;
    }
  | { kind: "correction"; reference: string; note: string }
  | { kind: "ambiguous"; missing: string[]; normalizedText: string };

export interface CategoryAliasRecord {
  alias: string;
  categoryId: string;
  categoryType: BookkeepingCategoryType;
  categoryName: string;
}

export interface TelegramMessage {
  updateId: number;
  chatId: number;
  userId: number;
  text: string;
  callbackQueryId?: string;
}

export interface PendingReviewItem {
  updateId: number;
  userId: number;
  chatId: number;
  text: string;
  reason: string;
  payload: unknown;
}

export interface EzBookkeepingResult {
  ok: boolean;
  status?: number;
  transactionId?: string;
  error?: string;
}

export interface AppConfig {
  port: number;
  telegramBotToken?: string;
  telegramWebhookSecret?: string;
  telegramAllowedUserIds: Set<number>;
  telegramReportChatId?: string;
  ezBookkeepingBaseUrl?: string;
  ezBookkeepingApiToken?: string;
  ezBookkeepingAccountIds: Record<string, string>;
  ezBookkeepingCategoryIds: Record<string, string>;
  defaultCurrency: string;
  defaultExpenseAccount?: string;
  defaultIncomeAccount?: string;
  assistantDbPath: string;
  portfolioDbPath: string;
  portfolioExportDir: string;
  portfolioAccountIdentitySalt: string;
  portfolioWriterLeaseMinutes: number;
  portfolioSnapshotRetentionDays: number;
  portfolioExportRetentionDays: number;
  portfolioRawImportRetentionDays: number;
  reportDir: string;
  watchlistPath: string;
  timezone: string;
  assistantInternalToken?: string;
  llmEnabled: boolean;
  llmSummaryEndpoint?: string;
  llmApiKey?: string;
  sinoPacApiKey?: string;
  sinoPacSecretKey?: string;
  sinoPacCaPath?: string;
  sinoPacCaPassword?: string;
  sinoPacPersonId?: string;
  sinoPacShioajiCommand?: string;
  sinoPacShioajiTimeoutMs: number;
}
