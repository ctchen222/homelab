import { AppConfig } from "./types";

function parseInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseUserIds(value: string | undefined): Set<number> {
  const ids = new Set<number>();
  if (!value) return ids;

  for (const item of value.split(",")) {
    const parsed = Number.parseInt(item.trim(), 10);
    if (Number.isSafeInteger(parsed) && parsed > 0) {
      ids.add(parsed);
    }
  }

  return ids;
}

function parseJsonMap(value: string | undefined): Record<string, string> {
  if (!value) return {};

  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected JSON object map");
  }

  const result: Record<string, string> = {};
  for (const [key, mapValue] of Object.entries(parsed)) {
    if (typeof mapValue === "string" && mapValue.trim().length > 0) {
      result[key.toLowerCase()] = mapValue;
    }
  }
  return result;
}

function cleanOptional(value: string | undefined): string | undefined {
  const cleaned = value?.trim();
  return cleaned || undefined;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  return {
    port: parseInteger(env.PORT, 8090),
    telegramBotToken: env.TELEGRAM_BOT_TOKEN,
    telegramWebhookSecret: env.TELEGRAM_WEBHOOK_SECRET,
    telegramAllowedUserIds: parseUserIds(env.TELEGRAM_ALLOWED_USER_IDS),
    telegramReportChatId: env.TELEGRAM_REPORT_CHAT_ID,
    ezBookkeepingBaseUrl: env.EZBOOKKEEPING_BASE_URL,
    ezBookkeepingApiToken: env.EZBOOKKEEPING_API_TOKEN,
    ezBookkeepingAccountIds: parseJsonMap(env.EZBOOKKEEPING_ACCOUNT_IDS),
    ezBookkeepingCategoryIds: parseJsonMap(env.EZBOOKKEEPING_CATEGORY_IDS),
    defaultCurrency: cleanOptional(env.DEFAULT_CURRENCY)?.toUpperCase() || "TWD",
    defaultExpenseAccount: cleanOptional(env.DEFAULT_EXPENSE_ACCOUNT),
    defaultIncomeAccount: cleanOptional(env.DEFAULT_INCOME_ACCOUNT),
    assistantDbPath: env.ASSISTANT_DB_PATH || "/data/assistant.sqlite",
    portfolioDbPath: env.PORTFOLIO_DB_PATH || "/data/portfolio/portfolio.sqlite",
    portfolioExportDir: env.PORTFOLIO_EXPORT_DIR || "/data/portfolio/exports",
    portfolioAccountIdentitySalt: cleanOptional(env.PORTFOLIO_ACCOUNT_IDENTITY_SALT) || "",
    portfolioWriterLeaseMinutes: parseInteger(env.PORTFOLIO_WRITER_LEASE_MINUTES, 30),
    portfolioSnapshotRetentionDays: parseInteger(env.PORTFOLIO_SNAPSHOT_RETENTION_DAYS, 30),
    portfolioExportRetentionDays: parseInteger(env.PORTFOLIO_EXPORT_RETENTION_DAYS, 90),
    portfolioRawImportRetentionDays: parseInteger(env.PORTFOLIO_RAW_IMPORT_RETENTION_DAYS, 90),
    reportDir: env.REPORT_DIR || "/data/reports",
    watchlistPath: env.WATCHLIST_PATH || "/config/watchlist.json",
    timezone: env.TZ || "Asia/Taipei",
    assistantInternalToken: env.ASSISTANT_INTERNAL_TOKEN,
    llmEnabled: env.LLM_ENABLED === "true",
    llmSummaryEndpoint: env.LLM_SUMMARY_ENDPOINT,
    llmApiKey: env.LLM_API_KEY,
    sinoPacApiKey: cleanOptional(env.SINOPAC_API_KEY),
    sinoPacSecretKey: cleanOptional(env.SINOPAC_SECRET_KEY),
    sinoPacCaPath: cleanOptional(env.SINOPAC_CA_PATH),
    sinoPacCaPassword: cleanOptional(env.SINOPAC_CA_PASSWORD),
    sinoPacPersonId: cleanOptional(env.SINOPAC_PERSON_ID),
    sinoPacShioajiCommand: cleanOptional(env.SINOPAC_SHIOAJI_COMMAND),
    sinoPacShioajiTimeoutMs: parseInteger(env.SINOPAC_SHIOAJI_TIMEOUT_MS, 90000)
  };
}
