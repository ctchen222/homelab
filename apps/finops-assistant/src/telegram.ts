import {
  AppConfig,
  BookkeepingCategoryType,
  BookkeepingDraft,
  BookkeepingDraftStep,
  CategoryAliasRecord,
  EzBookkeepingResult,
  PendingReviewItem,
  ParsedCallback,
  TransactionType,
  ParsedTransaction,
  TelegramMessage,
} from "./types";
import { createHash } from "node:crypto";
import {
  aliasFromCategoryName,
  ensureTransactionCategory,
  flattenCategories,
  listAccounts,
  listTransactionCategories,
  lookupAlias,
  transactionCategoryType,
  writeTransaction,
} from "./ezbookkeeping";
import { parseMessage } from "./parser";
import { generateSpendingOverview } from "./report";

interface StoreLike {
  isProcessed(updateId: number): boolean;
  markProcessed(updateId: number, outcome: string): void;
  addPendingReview(item: PendingReviewItem): void;
  getPendingReviewByUpdateId?(updateId: number): PendingReviewItem | undefined;
  resolvePendingReview?(updateId: number): void;
  pendingReviewCount(): number;
  categoryAliases?(): Record<string, string>;
  categoryAliasRecords?(): CategoryAliasRecord[];
  saveCategoryAlias?(
    alias: string,
    categoryId: string,
    categoryType: BookkeepingCategoryType,
    categoryName: string,
  ): void;
  expireOutdatedDrafts?(): number;
  getActiveDraft?(userId: number, chatId: number): BookkeepingDraft | undefined;
  createBookkeepingDraft?: (
    draft: Omit<BookkeepingDraft, "createdAt" | "updatedAt" | "expiresAt"> & { expiresAt?: string },
  ) => string;
  getDraft?: (draftId: string) => BookkeepingDraft | undefined;
  updateBookkeepingDraft?: (
    draftId: string,
    patch: Partial<
      Omit<
        BookkeepingDraft,
        "draftId" | "userId" | "chatId" | "sourceUpdateId" | "createdAt"
      >
    >,
  ) => void;
  cancelBookkeepingDraft?: (draftId: string, reason?: string) => void;
  failBookkeepingDraft?: (draftId: string, reason: string) => void;
  confirmBookkeepingDraft?: (draftId: string, writeTransactionId: string) => void;
}

type DraftFlowState = Omit<BookkeepingDraft, "createdAt" | "updatedAt" | "expiresAt"> & {
  expiresAt?: string;
};

export interface TelegramUpdateResult {
  status:
    | "accepted"
    | "duplicate"
    | "unauthorized"
    | "pending_review"
    | "failed";
  message: string;
}

export function extractTelegramMessage(
  update: unknown,
): TelegramMessage | undefined {
  const candidate = update as {
    update_id?: unknown;
    message?: any;
    edited_message?: any;
    callback_query?: any;
  };
  const message = candidate.message || candidate.edited_message;
  const callbackQuery = candidate.callback_query;
  const updateId = candidate.update_id;

  if (callbackQuery) {
    const callbackMessage = callbackQuery.message;
    const fromId = callbackQuery.from?.id;
    const chatId = callbackMessage?.chat?.id;
    const callbackData = callbackQuery.data;

    if (
      Number.isSafeInteger(updateId) &&
      Number.isSafeInteger(fromId) &&
      Number.isSafeInteger(chatId) &&
      typeof callbackData === "string" &&
      callbackData.length > 0
    ) {
      return {
        updateId: Number(updateId),
        userId: Number(fromId),
        chatId: Number(chatId),
        text: callbackData,
        callbackQueryId: callbackQuery.id || `${updateId}`,
        callbackMessageId: callbackMessage?.message_id ? Number(callbackMessage.message_id) : undefined,
      };
    }
  }

  const userId = message?.from?.id;
  const chatId = message?.chat?.id;
  const text = message?.text;

  if (
    !Number.isSafeInteger(updateId) ||
    !Number.isSafeInteger(userId) ||
    !Number.isSafeInteger(chatId) ||
    typeof text !== "string"
  ) {
    return undefined;
  }

  return {
    updateId: Number(updateId),
    userId: Number(userId),
    chatId: Number(chatId),
    text,
  };
}

const TELEGRAM_API_BASE = "https://api.telegram.org/bot";
const CALLBACK_PREFIX = "finops:d";
const CALLBACK_SEPARATOR = ":";
const DRAFT_TTL_MINUTES = 15;
const LIST_PAGE_SIZE = 6;
const CALLBACK_DATA_LIMIT = 64;
const TYPE_ACTION_EXPENSE = "ex";
const TYPE_ACTION_INCOME = "in";
const TYPE_ACTION_TRANSFER = "tr";

type DraftCallbackAction =
  | "step_type"
  | "set_type"
  | "set_date"
  | "set_amount"
  | "set_category"
  | "set_account"
  | "set_from_account"
  | "set_to_account"
  | "select_category"
  | "select_account"
  | "page_category"
  | "page_account"
  | "edit_type"
  | "edit_date"
  | "edit_amount"
  | "edit_category"
  | "edit_account"
  | "edit_from_account"
  | "edit_to_account"
  | "edit_note"
  | "back"
  | "new_category"
  | "new_category_confirm"
  | "create_category"
  | "confirm"
  | "cancel"
  | "close";

function safeDraftId(seed: string): string {
  return createHash("sha1").update(seed).digest("hex").slice(0, 10);
}

function nowIso(): string {
  return new Date().toISOString();
}

function localIsoDateForOffset(now = new Date(), dayOffset = 0, timezone = "Asia/Taipei"): string {
  const offsetMinutes = timezone === "Asia/Taipei" || timezone === "Asia/Shanghai" ? 480 : 0;
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const [year, month, day] = today.split("-").map((value) => Number.parseInt(value, 10));
  const base = new Date(Date.UTC(year, month - 1, day + dayOffset) - offsetMinutes * 60_000);
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const date = formatter.format(base);
  return `${date}T00:00:00.000${offsetMinutes === 480 ? "+08:00" : "+00:00"}`;
}

function parseDraftDateInput(value: string, now = new Date(), timezone = "Asia/Taipei"): string | undefined {
  const token = value.trim().toLowerCase();
  if (["今天", "today", "今日"].includes(token)) return localIsoDateForOffset(now, 0, timezone);
  if (["昨天", "yesterday"].includes(token)) return localIsoDateForOffset(now, -1, timezone);
  if (["前天", "daybefore", "day-before", "2daysago", "two days ago"].includes(token)) return localIsoDateForOffset(now, -2, timezone);

  const yyyyMmDd = token.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (yyyyMmDd) {
    const [, year, month, day] = yyyyMmDd;
    const parsed = localIsoDateForOffset(new Date(Number(year), Number(month) - 1, Number(day)), 0, timezone);
    const today = localIsoDateForOffset(now, 0, timezone);
    if (parsed > today) return undefined;
    return parsed;
  }

  const mmDd = token.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (mmDd) {
    const [, month, day] = mmDd;
    const nowParts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now).split("-").map((value) => Number.parseInt(value, 10));
    const parsed = localIsoDateForOffset(new Date(nowParts[0], Number(month) - 1, Number(day)), 0, timezone);
    const today = localIsoDateForOffset(now, 0, timezone);
    if (parsed > today) return undefined;
    return parsed;
  }

  return undefined;
}

function parseAmountValue(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return undefined;
  const amount = Number.parseFloat(normalized);
  return Number.isFinite(amount) && amount > 0 ? amount : undefined;
}

function parseCallbackData(data: string | undefined): ParsedCallback | undefined {
  if (!data) return undefined;
  if (!data.startsWith(CALLBACK_PREFIX + CALLBACK_SEPARATOR)) return undefined;
  const parts = data.split(":");
  if (parts.length < 4) return undefined;
  const [, , draftId, action] = parts;
  if (!draftId || !action) return undefined;
  if (!isDraftCallbackAction(action)) return undefined;
  const typedAction = action as DraftCallbackAction;
  return {
    draftId,
    action: typedAction,
    value: parts.slice(4).join(":" ) || undefined,
  };
}

function isDraftCallbackAction(action: string): action is DraftCallbackAction {
  return (
    action === "step_type" ||
    action === "set_type" ||
    action === "set_date" ||
    action === "set_amount" ||
    action === "set_category" ||
    action === "set_account" ||
    action === "set_from_account" ||
    action === "set_to_account" ||
    action === "select_category" ||
    action === "select_account" ||
    action === "page_category" ||
    action === "page_account" ||
    action === "edit_type" ||
    action === "edit_date" ||
    action === "edit_amount" ||
    action === "edit_category" ||
    action === "edit_account" ||
    action === "edit_from_account" ||
    action === "edit_to_account" ||
    action === "edit_note" ||
    action === "back" ||
    action === "new_category" ||
    action === "new_category_confirm" ||
    action === "create_category" ||
    action === "confirm" ||
    action === "cancel" ||
    action === "close"
  );
}

function isActionAllowedForDraftStep(
  step: BookkeepingDraftStep,
  action: DraftCallbackAction,
  draft: DraftFlowState,
): boolean {
  if (action === "page_category") {
    if (draft.type === "transfer") {
      return step === "from_account" || step === "to_account";
    }
    return step === "category" || step === "account";
  }

  if (action === "page_account") {
    if (draft.type === "transfer") {
      return step === "from_account" || step === "to_account";
    }
    return step === "category" || step === "account";
  }

  switch (step) {
    case "type":
      return action === "set_type" || action === "cancel" || action === "close";
    case "amount":
      return action === "set_amount"
        || action === "edit_type"
        || action === "back"
        || action === "cancel"
        || action === "close";
    case "date":
      return action === "set_date"
        || action === "edit_type"
        || action === "edit_note"
        || action === "back"
        || action === "cancel"
        || action === "close";
    case "note":
      return action === "edit_note"
        || action === "edit_category"
        || action === "edit_account"
        || action === "edit_from_account"
        || action === "edit_to_account"
        || action === "back"
        || action === "cancel"
        || action === "close";
    case "category":
      return action === "select_category"
        || action === "new_category"
        || action === "edit_type"
        || action === "back"
        || action === "cancel"
        || action === "close";
    case "account":
      return action === "select_account"
        || action === "edit_type"
        || action === "edit_category"
        || action === "back"
        || action === "cancel"
        || action === "close";
    case "from_account":
      return action === "set_from_account"
        || action === "edit_type"
        || action === "edit_to_account"
        || action === "back"
        || action === "cancel"
        || action === "close";
    case "to_account":
      return action === "set_to_account"
        || action === "edit_type"
        || action === "edit_from_account"
        || action === "back"
        || action === "cancel"
        || action === "close";
    case "new_category_name":
      return action === "back" || action === "cancel" || action === "close";
    case "new_category_parent":
      return action === "new_category_confirm"
        || action === "back"
        || action === "cancel"
        || action === "close";
    case "new_category_confirm":
      return action === "create_category"
        || action === "back"
        || action === "cancel"
        || action === "close";
    case "confirm":
      return action === "confirm"
        || action === "edit_type"
        || action === "edit_date"
        || action === "edit_amount"
        || action === "edit_category"
        || action === "edit_account"
        || action === "edit_from_account"
        || action === "edit_to_account"
        || action === "edit_note"
        || action === "back"
        || action === "cancel"
        || action === "close";
  }

  return false;
}

function formatCallbackData(draftId: string, action: string, value?: string): string {
  const valuePart = value === undefined ? "" : CALLBACK_SEPARATOR + value;
  const data = `${CALLBACK_PREFIX}${CALLBACK_SEPARATOR}${draftId}${CALLBACK_SEPARATOR}${action}${valuePart}`;
  if (data.length > CALLBACK_DATA_LIMIT) {
    throw new Error("callback data too long");
  }
  return data;
}

function callbackRow(draftId: string, action: string, value: string | undefined, label: string): { text: string; callback_data: string } {
  return {
    text: label,
    callback_data: formatCallbackData(draftId, action, value),
  };
}

function previousDraftStep(draft: DraftFlowState): BookkeepingDraftStep | undefined {
  switch (draft.step) {
    case "type":
      return undefined;
    case "amount":
      return "type";
    case "date":
      return "amount";
    case "note":
      return draft.type === "transfer" ? "to_account" : "account";
    case "category":
      return "account";
    case "account":
      return "category";
    case "from_account":
      return "date";
    case "to_account":
      return "from_account";
    case "new_category_name":
      return "category";
    case "new_category_parent":
      return "new_category_name";
    case "new_category_confirm":
      return "new_category_parent";
    case "confirm":
      return "note";
    default:
      return undefined;
  }
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function stripHtmlTags(value: string): string {
  return value
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

async function responseBody(response: Response): Promise<string> {
  return response.text().catch(() => "");
}

function isTelegramHtmlParseError(status: number, body: string): boolean {
  return status === 400 && /can't parse entities/i.test(body);
}

export async function sendTelegramMessage(
  config: AppConfig,
  chatId: number | string,
  text: string,
  fetchImpl: typeof fetch = fetch,
  replyMarkup?: unknown,
): Promise<boolean> {
  if (!config.telegramBotToken) return false;

  const send = async (payloadText: string, parseMode?: string): Promise<Response> =>
    fetchImpl(`${TELEGRAM_API_BASE}${config.telegramBotToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: payloadText,
        disable_web_page_preview: true,
        ...(parseMode ? { parse_mode: parseMode } : {}),
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      }),
    });

  try {
    let response = await send(text, "HTML");
    let body = response.ok ? "" : await responseBody(response);
    if (!response.ok && isTelegramHtmlParseError(response.status, body)) {
      // Malformed entities make Telegram reject the whole message; deliver plain text instead of losing it.
      response = await send(stripHtmlTags(text));
      body = response.ok ? "" : await responseBody(response);
    }

    if (!response.ok) {
      console.warn(
        "telegram delivery failed",
        JSON.stringify({ status: response.status, body: body.slice(0, 200) }),
      );
      return false;
    }

    return true;
  } catch (error) {
    console.warn(
      "telegram delivery failed",
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}

async function sendTelegramEditMessage(
  config: AppConfig,
  chatId: number | string,
  messageId: number,
  text: string,
  fetchImpl: typeof fetch = fetch,
  replyMarkup?: unknown,
): Promise<boolean> {
  if (!config.telegramBotToken) return false;

  try {
    const send = async (payloadText: string, parseMode?: string): Promise<Response> =>
      fetchImpl(`${TELEGRAM_API_BASE}${config.telegramBotToken}/editMessageText`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
          text: payloadText,
          disable_web_page_preview: true,
          ...(parseMode ? { parse_mode: parseMode } : {}),
          ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        }),
      });

    let response = await send(text, "HTML");
    let body = response.ok ? "" : await responseBody(response);
    if (!response.ok && isTelegramHtmlParseError(response.status, body)) {
      response = await send(stripHtmlTags(text));
      body = response.ok ? "" : await responseBody(response);
    }

    if (!response.ok) {
      console.warn(
        "telegram editMessageText failed",
        JSON.stringify({ status: response.status, body: body.slice(0, 200) }),
      );
      return false;
    }

    return true;
  } catch (error) {
    console.warn(
      "telegram editMessageText failed",
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}

async function sendTelegramEditMessageReplyMarkup(
  config: AppConfig,
  chatId: number | string,
  messageId: number,
  replyMarkup: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (!config.telegramBotToken) return false;

  try {
    const response = await fetchImpl(`${TELEGRAM_API_BASE}${config.telegramBotToken}/editMessageReplyMarkup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        reply_markup: replyMarkup,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.warn(
        "telegram editMessageReplyMarkup failed",
        JSON.stringify({ status: response.status, body: body.slice(0, 200) }),
      );
      return false;
    }

    return true;
  } catch (error) {
    console.warn(
      "telegram editMessageReplyMarkup failed",
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}

async function answerCallbackQuery(
  config: AppConfig,
  callbackQueryId: string | undefined,
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (!config.telegramBotToken || !callbackQueryId) return false;

  try {
    const response = await fetchImpl(`${TELEGRAM_API_BASE}${config.telegramBotToken}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        callback_query_id: callbackQueryId,
        text,
        show_alert: false,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.warn(
        "telegram answerCallbackQuery failed",
        JSON.stringify({ status: response.status, body: body.slice(0, 200) }),
      );
      return false;
    }

    return true;
  } catch (error) {
    console.warn(
      "telegram answerCallbackQuery failed",
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}

function mergedCategoryAliases(config: AppConfig, store: StoreLike): Record<string, string> {
  return {
    ...config.ezBookkeepingCategoryIds,
    ...(store.categoryAliases?.() || {}),
  };
}

function configWithStoreAliases(config: AppConfig, store: StoreLike): AppConfig {
  return {
    ...config,
    ezBookkeepingCategoryIds: mergedCategoryAliases(config, store),
  };
}

function normalizeAlias(alias: string): string {
  return alias.trim().replace(/\s+/g, " ").toLowerCase();
}

function aliasesForCategory(categoryId: string, records: CategoryAliasRecord[], configMap: Record<string, string>): string[] {
  const aliases = new Set<string>();
  for (const [alias, mappedId] of Object.entries(configMap)) {
    if (mappedId === categoryId) aliases.add(alias);
  }
  for (const record of records) {
    if (record.categoryId === categoryId) aliases.add(record.alias);
  }
  return [...aliases].sort();
}

function aliasesForAccount(accountId: string, configMap: Record<string, string>): string[] {
  return Object.entries(configMap)
    .filter(([, mappedId]) => mappedId === accountId)
    .map(([alias]) => alias)
    .sort();
}

function typeLabel(categoryType: BookkeepingCategoryType): string {
  if (categoryType === "income") return "收入";
  if (categoryType === "transfer") return "轉帳";
  return "支出";
}

async function formatCategoriesMessage(
  config: AppConfig,
  store: StoreLike,
  categoryType: BookkeepingCategoryType | undefined,
  fetchImpl: typeof fetch,
): Promise<string> {
  const records = store.categoryAliasRecords?.() || [];
  const categories = await listTransactionCategories(config, categoryType, fetchImpl);
  const lines = [`<b>FinOps 分類${categoryType ? `（${typeLabel(categoryType)}）` : ""}</b>`];
  const flat = flattenCategories(categories).filter((category) => category.parentId !== "0");

  if (flat.length === 0) {
    lines.push("・目前沒有可用分類。");
  } else {
    for (const category of flat) {
      const aliases = aliasesForCategory(category.id, records, config.ezBookkeepingCategoryIds);
      lines.push(`・${escapeHtml(category.name)}${aliases.length ? `: ${escapeHtml(aliases.join(", "))}` : ""}`);
    }
  }

  lines.push("");
  lines.push("新增分類：category add expense transport under Transportation");
  lines.push("確認待審：category confirm &lt;update_id&gt; under Transportation");
  return lines.join("\n");
}

async function formatAccountsMessage(
  config: AppConfig,
  fetchImpl: typeof fetch,
): Promise<string> {
  const accounts = await listAccounts(config, fetchImpl);
  const lines = ["<b>FinOps 帳戶</b>"];

  if (accounts.length === 0) {
    lines.push("・目前沒有可用帳戶。");
  } else {
    for (const account of accounts.filter((item) => !item.hidden)) {
      const aliases = aliasesForAccount(account.id, config.ezBookkeepingAccountIds);
      lines.push(`・${escapeHtml(account.name)}${account.currency ? ` (${escapeHtml(account.currency)})` : ""}${aliases.length ? `: ${escapeHtml(aliases.join(", "))}` : ""}`);
    }
  }

  return lines.join("\n");
}

function fallbackAliasList(title: string, aliases: Record<string, string>): string {
  const names = Object.keys(aliases).sort();
  return [`<b>${escapeHtml(title)}</b>`, names.length ? names.map((alias) => `・${escapeHtml(alias)}`).join("\n") : "・尚未設定別名。"].join("\n");
}

async function saveCategoryFromTelegram(
  config: AppConfig,
  store: StoreLike,
  input: {
    categoryType: BookkeepingCategoryType;
    name: string;
    parentName?: string;
    alias?: string;
  },
  fetchImpl: typeof fetch,
): Promise<{ categoryId: string; categoryName: string; alias: string }> {
  const category = await ensureTransactionCategory(config, input, fetchImpl);
  const alias = normalizeAlias(input.alias || aliasFromCategoryName(input.name));
  store.saveCategoryAlias?.(alias, category.id, input.categoryType, category.name);

  return {
    categoryId: category.id,
    categoryName: category.name,
    alias,
  };
}

async function mappedCategoryTypeMismatch(
  config: AppConfig,
  transaction: ParsedTransaction,
  categoryId: string,
  fetchImpl: typeof fetch,
): Promise<BookkeepingCategoryType | undefined> {
  const expectedType = transactionCategoryType(transaction.type);
  const categories = await listTransactionCategories(config, undefined, fetchImpl);
  const category = flattenCategories(categories).find((item) => item.id === categoryId);
  if (!category) return undefined;

  if (expectedType === "income" && category.type !== 1) return category.type === 2 ? "expense" : "transfer";
  if (expectedType === "expense" && category.type !== 2) return category.type === 1 ? "income" : "transfer";
  if (expectedType === "transfer" && category.type !== 3) return category.type === 1 ? "income" : "expense";
  return undefined;
}

async function validateCategoryBeforeWrite(
  config: AppConfig,
  store: StoreLike,
  transaction: ParsedTransaction,
  fetchImpl: typeof fetch,
): Promise<{ ok: true } | { ok: false; reason: string; text: string }> {
  if (transaction.type === "transfer") return { ok: true };

  const categoryAlias = transaction.category || "";
  const categoryId = lookupAlias(config.ezBookkeepingCategoryIds, categoryAlias);
  if (!categoryId) {
    const categoryType = transactionCategoryType(transaction.type);
    return {
      ok: false,
      reason: `unknown_category:${categoryType}:${categoryAlias}`,
      text: [
        `⚠️ 未知的 ${categoryType} 分類別名：${escapeHtml(categoryAlias)}`,
        `建立並重試此交易：category confirm <update_id> under Miscellaneous`,
        `或只新增分類：category add ${categoryType} ${escapeHtml(categoryAlias)}`,
        `用 categories expense|income|transfer 查看現有分類。`,
      ].join("\n"),
    };
  }

  try {
    const actualType = await mappedCategoryTypeMismatch(config, transaction, categoryId, fetchImpl);
    if (actualType) {
      const expectedType = transactionCategoryType(transaction.type);
      return {
        ok: false,
        reason: `category_type_mismatch:${expectedType}:${categoryAlias}`,
        text: `分類別名「${escapeHtml(categoryAlias)}」屬於 ${actualType}，不是 ${expectedType}。請用 categories ${expectedType} 選擇正確分類。`,
      };
    }
  } catch {
    return { ok: true };
  }

  return { ok: true };
}

function formatDateOnly(value: string): string {
  return value.slice(0, 10);
}

function isSlashCommand(text: string): boolean {
  return text.trim().startsWith("/");
}

function makeDraftId(config: AppConfig, message: TelegramMessage): string {
  return safeDraftId(`${config.assistantDbPath}:${message.userId}:${message.chatId}:${message.updateId}`);
}

function draftExpiry(now = new Date()): string {
  return new Date(now.getTime() + DRAFT_TTL_MINUTES * 60_000).toISOString();
}

function draftNeeds(draft: DraftFlowState): { step: BookkeepingDraftStep } {
  if (!draft.amount) return { step: "amount" };
  if (!draft.transactionDate) return { step: "date" };
  if (draft.type === "transfer") {
    if (!draft.fromAccountId) return { step: "from_account" };
    if (!draft.toAccountId) return { step: "to_account" };
    return { step: draft.note ? "confirm" : "note" };
  }
  if (!draft.categoryId && !draft.categoryName) return { step: "category" };
  if (!draft.accountId && !draft.accountName && !draft.accountAlias) return { step: "account" };
  return { step: draft.note ? "confirm" : "note" };
}

function isDraftExpired(draft: DraftFlowState, now = new Date()): boolean {
  if (!draft.expiresAt) return false;
  return new Date(draft.expiresAt).getTime() <= now.getTime();
}

function draftIsReadyToConfirm(draft: DraftFlowState): boolean {
  return draftNeeds(draft).step === "confirm";
}

function draftTypeLabel(type: TransactionType): string {
  if (type === "income") return "收入";
  if (type === "transfer") return "轉帳";
  return "支出";
}

function formatDraftAmount(amount: number): string {
  return Number.isInteger(amount) ? amount.toLocaleString("en-US") : amount.toFixed(2);
}

function createDraftSummaryLine(draft: DraftFlowState): string {
  const currency = draft.currency || "TWD";
  const amount = draft.amount ? `${currency} ${formatDraftAmount(draft.amount)}` : "尚未設定";
  const date = formatDateOnly(draft.transactionDate);
  const header = `🧾 <b>記帳草稿</b>｜${draftTypeLabel(draft.type)}`;
  const lines = [header, `金額：${amount}`, `日期：${date}`];
  if (draft.type === "transfer") {
    lines.push(`來源：${escapeHtml(draft.fromAccountName || "尚未設定")}`);
    lines.push(`目標：${escapeHtml(draft.toAccountName || "尚未設定")}`);
  } else {
    lines.push(`分類：${escapeHtml(draft.categoryName || draft.categoryAlias || "尚未設定")}`);
    lines.push(`帳戶：${escapeHtml(draft.accountName || draft.accountAlias || "尚未設定")}`);
  }
  lines.push(`備註：${escapeHtml(draft.note || "－")}`);
  return lines.join("\n");
}

function draftToParsedTransaction(draft: DraftFlowState, defaultCurrency: string): ParsedTransaction {
  const currency = draft.currency || defaultCurrency;
  const base: ParsedTransaction = {
    type: draft.type,
    amount: draft.amount || 0,
    currency,
    occurredAt: draft.transactionDate,
    note: draft.note,
    currencyDefaulted: !draft.currency,
  };

  if (draft.type === "transfer") {
    return {
      ...base,
      fromAccountId: draft.fromAccountId,
      toAccountId: draft.toAccountId,
    };
  }

  return {
    ...base,
    categoryId: draft.categoryId,
    accountId: draft.accountId,
    category: draft.categoryAlias || draft.categoryName,
    account: draft.accountAlias || draft.accountName,
  };
}

function createDraftFromQuickSentence(config: AppConfig, message: TelegramMessage, quick: {
  type: "expense" | "income" | "transfer";
  amount: number;
  currency: string;
  note: string;
  occurredAt: string;
  explicitType: boolean;
}): DraftFlowState {
  const draftId = makeDraftId(config, message);
  return {
    draftId,
    userId: message.userId,
    chatId: message.chatId,
    sourceUpdateId: message.updateId,
    type: quick.type,
    amount: quick.amount,
    currency: quick.currency,
    transactionDate: quick.occurredAt,
    note: quick.note,
    step: draftNeeds({
      draftId,
      userId: message.userId,
      chatId: message.chatId,
      sourceUpdateId: message.updateId,
      type: quick.type,
      amount: quick.amount,
      currency: quick.currency,
      transactionDate: quick.occurredAt,
      note: quick.note,
      step: "type",
      status: "active",
    }).step,
    status: "active",
  };
}

function inlineButton(draftId: string, action: string, value: string | undefined, text: string) {
  return {
    text,
    callback_data: formatCallbackData(draftId, action, value),
  };
}

function parseQuickDateInput(value: string, now = new Date(), timezone = "Asia/Taipei"): string | undefined {
  return parseDraftDateInput(value, now, timezone);
}

function isTransferTypeInput(value: string): boolean {
  return ["transfer", "轉帳", "轉賬", "move"].includes(value);
}

function isIncomeTypeInput(value: string): boolean {
  return ["income", "收入", "salary"].includes(value);
}

function isExpenseTypeInput(value: string): boolean {
  return ["expense", "支出"].includes(value);
}

function detectTypeFromText(input: string): "expense" | "income" | "transfer" | undefined {
  const text = input.trim().toLowerCase();
  if (isExpenseTypeInput(text)) return "expense";
  if (isIncomeTypeInput(text)) return "income";
  if (isTransferTypeInput(text)) return "transfer";
  return undefined;
}

function buildDraftPromptText(draft: DraftFlowState): string {
  const summary = createDraftSummaryLine(draft);
  if (draft.step === "type") return `${summary}\n\n請選擇交易類型：`;
  if (draft.step === "amount") return `${summary}\n\n請輸入金額：`;
  if (draft.step === "date") return `${summary}\n\n請選擇/輸入日期（今天/昨天/前天/MM/DD/YYYY-MM-DD）：`;
  if (draft.step === "note") return `${summary}\n\n請輸入備註：`;
  if (draft.step === "category") return `${summary}\n\n請選擇或輸入分類：`;
  if (draft.step === "account") return `${summary}\n\n請選擇或輸入付款/收入帳戶：`;
  if (draft.step === "from_account") return `${summary}\n\n請選擇轉帳來源帳戶：`;
  if (draft.step === "to_account") return `${summary}\n\n請選擇轉帳目標帳戶：`;
  if (draft.step === "new_category_name") return `${summary}\n\n請輸入新分類名稱：`;
  if (draft.step === "new_category_parent") return `${summary}\n\n請輸入新分類上層：`;
  if (draft.step === "new_category_confirm") return `${summary}\n\n請確認建立新分類。`;
  return `${summary}\n\n確認後將寫入記帳。`;
}

type DraftPromptRenderMode = "full" | "markup-only";

function clampPage(value: number, totalPages: number): number {
  if (Number.isNaN(value) || value < 0) return 0;
  if (totalPages <= 1) return 0;
  if (value >= totalPages) return totalPages - 1;
  return value;
}

async function renderDraftPrompt(
  config: AppConfig,
  draft: DraftFlowState,
  fetchImpl: typeof fetch,
  messageId?: number,
  page = 0,
  options: { mode?: DraftPromptRenderMode } = {},
): Promise<void> {
  let categories: Array<{ id: string; name: string }> = [];
  let accounts: Array<{ id: string; name: string; hidden?: boolean; currency?: string }> = [];

  if (draft.step === "category" || draft.step === "new_category_parent") {
    try {
      const loaded = await listTransactionCategories(config, draft.type === "transfer" ? undefined : draft.type, fetchImpl);
      categories = flattenCategories(loaded)
        .filter((entry) => entry.parentId !== "0")
        .map((entry) => ({ id: entry.id, name: entry.name }));
    } catch (error) {
      console.warn("failed to list categories for draft", error instanceof Error ? error.message : String(error));
    }
  }

  if (draft.step === "account" || draft.step === "from_account" || draft.step === "to_account") {
    try {
      accounts = await listAccounts(config, fetchImpl);
    } catch (error) {
      console.warn("failed to list accounts for draft", error instanceof Error ? error.message : String(error));
    }
  }

  const rows: Array<Array<{ text: string; callback_data: string }>> = [];

  if (draft.step === "type") {
    rows.push([
      inlineButton(draft.draftId, "set_type", "expense", "Expense"),
      inlineButton(draft.draftId, "set_type", "income", "Income"),
      inlineButton(draft.draftId, "set_type", "transfer", "Transfer"),
    ]);
    rows.push([inlineButton(draft.draftId, "cancel", undefined, "Cancel")]);
  } else if (draft.step === "date") {
    rows.push([
      inlineButton(draft.draftId, "set_date", "today", "今天"),
      inlineButton(draft.draftId, "set_date", "yesterday", "昨天"),
      inlineButton(draft.draftId, "set_date", "daybefore", "前天"),
      inlineButton(draft.draftId, "set_date", "custom", "Custom"),
    ]);
    rows.push([
      inlineButton(draft.draftId, "edit_note", undefined, "Edit note"),
      inlineButton(draft.draftId, "back", undefined, "Back"),
      inlineButton(draft.draftId, "cancel", undefined, "Cancel"),
    ]);
  } else if (draft.step === "amount") {
    rows.push([
      inlineButton(draft.draftId, "edit_type", undefined, "Edit type"),
      inlineButton(draft.draftId, "back", undefined, "Back"),
      inlineButton(draft.draftId, "cancel", undefined, "Cancel"),
    ]);
  } else if (draft.step === "note") {
    rows.push([inlineButton(draft.draftId, "edit_category", undefined, draft.type === "transfer" ? "Edit accounts" : "Edit account"), inlineButton(draft.draftId, "cancel", undefined, "Cancel")]);
  } else if (draft.step === "category") {
    const limit = LIST_PAGE_SIZE;
    const totalPages = Math.max(1, Math.ceil(categories.length / limit));
    const safePage = clampPage(page, totalPages);
    const current = categories.slice(safePage * limit, (safePage + 1) * limit);
    for (const category of current) {
      rows.push([inlineButton(draft.draftId, "select_category", category.id, category.name)]);
    }
    if (totalPages > 1) {
      const navigation = [];
      if (safePage > 0) navigation.push(inlineButton(draft.draftId, "page_category", String(safePage - 1), "Prev"));
      if (safePage < totalPages - 1) navigation.push(inlineButton(draft.draftId, "page_category", String(safePage + 1), "Next"));
      if (navigation.length > 0) rows.push(navigation);
    }
    rows.push([inlineButton(draft.draftId, "new_category", undefined, "New category"), inlineButton(draft.draftId, "cancel", undefined, "Cancel")]);
  } else if (draft.step === "account" || draft.step === "from_account" || draft.step === "to_account") {
    const action = draft.step === "from_account" ? "set_from_account" : draft.step === "to_account" ? "set_to_account" : "select_account";
    const limit = LIST_PAGE_SIZE;
    const totalPages = Math.max(1, Math.ceil(accounts.length / limit));
    const safePage = clampPage(page, totalPages);
    const current = accounts
      .filter((account) => !account.hidden)
      .slice(safePage * limit, (safePage + 1) * limit)
      .map((account) => ({ id: account.id, name: `${account.name}${account.currency ? ` (${account.currency})` : ""}` }));
    for (const account of current) {
      rows.push([inlineButton(draft.draftId, action, account.id, account.name)]);
    }
    if (totalPages > 1) {
      const navigation = [];
      if (safePage > 0) navigation.push(inlineButton(draft.draftId, "page_account", String(safePage - 1), "Prev"));
      if (safePage < totalPages - 1) navigation.push(inlineButton(draft.draftId, "page_account", String(safePage + 1), "Next"));
      if (navigation.length > 0) rows.push(navigation);
    }
    rows.push([inlineButton(draft.draftId, "cancel", undefined, "Cancel")]);
  } else if (draft.step === "new_category_name") {
    rows.push([inlineButton(draft.draftId, "cancel", undefined, "Cancel")]);
  } else if (draft.step === "new_category_parent") {
    rows.push([inlineButton(draft.draftId, "new_category_confirm", undefined, "Use default parent"), inlineButton(draft.draftId, "cancel", undefined, "Cancel")]);
  } else if (draft.step === "new_category_confirm") {
    rows.push([
      inlineButton(draft.draftId, "create_category", "confirm", "Create and use"),
      inlineButton(draft.draftId, "create_category", "only", "Only create"),
      inlineButton(draft.draftId, "create_category", "cancel", "Cancel"),
    ]);
  } else if (draft.step === "confirm") {
    rows.push([
      inlineButton(draft.draftId, "confirm", undefined, "Confirm"),
      inlineButton(draft.draftId, "cancel", undefined, "Cancel"),
    ]);
    rows.push([
      inlineButton(draft.draftId, "edit_type", undefined, "Edit type"),
      inlineButton(draft.draftId, "edit_date", undefined, "Edit date"),
      inlineButton(draft.draftId, "edit_amount", undefined, "Edit amount"),
    ]);
    if (draft.type === "transfer") {
      rows.push([
        inlineButton(draft.draftId, "edit_from_account", undefined, "Edit from account"),
        inlineButton(draft.draftId, "edit_to_account", undefined, "Edit to account"),
      ]);
    } else {
      rows.push([
        inlineButton(draft.draftId, "edit_category", undefined, "Edit category"),
        inlineButton(draft.draftId, "edit_account", undefined, "Edit account"),
      ]);
    }
    rows.push([inlineButton(draft.draftId, "edit_note", undefined, "Edit note")]);
  } else {
    rows.push([inlineButton(draft.draftId, "cancel", undefined, "Cancel")]);
  }

  const payload = { inline_keyboard: rows };
  const text = buildDraftPromptText(draft);
  if (messageId) {
    if (options.mode === "markup-only") {
      const markupUpdated = await sendTelegramEditMessageReplyMarkup(config, draft.chatId, messageId, payload, fetchImpl);
      if (markupUpdated) return;
    }
    const edited = await sendTelegramEditMessage(config, draft.chatId, messageId, text, fetchImpl, payload);
    if (edited) return;
  }
  await sendTelegramMessage(config, draft.chatId, text, fetchImpl, payload);
}

function draftProgressStep(draft: DraftFlowState): BookkeepingDraftStep {
  return draftNeeds(draft).step;
}

function nextDraftStep(draft: DraftFlowState): DraftFlowState {
  return {
    ...draft,
    step: draftProgressStep(draft),
  };
}

function normalizeTextInput(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

async function resolveCategoryFromText(
  draft: BookkeepingDraft,
  text: string,
  config: AppConfig,
  fetchImpl: typeof fetch,
): Promise<{ id?: string; name?: string }> {
  const normalized = normalizeTextInput(text);
  if (!normalized) return {};

  const aliasId = lookupAlias(config.ezBookkeepingCategoryIds, normalized);
  if (aliasId) {
    return { id: aliasId };
  }

  try {
    const categories = flattenCategories(await listTransactionCategories(config, draft.type === "transfer" ? undefined : draft.type, fetchImpl));
    const matched = categories.find((category) => normalizeTextInput(category.name) === normalized);
    if (matched && matched.parentId !== "0") {
      return { id: matched.id, name: matched.name };
    }
  } catch (error) {
    console.warn("failed to resolve category by text", error instanceof Error ? error.message : String(error));
  }

  return {};
}

async function resolveAccountFromText(
  config: AppConfig,
  text: string,
  fetchImpl: typeof fetch,
): Promise<{ id?: string; name?: string; alias?: string }> {
  const normalized = normalizeTextInput(text);
  if (!normalized) return {};

  const aliasId = lookupAlias(config.ezBookkeepingAccountIds, normalized);
  if (aliasId) {
    return { id: aliasId };
  }

  try {
    const accounts = await listAccounts(config, fetchImpl);
    const matched = accounts.find((account) => normalizeTextInput(account.name) === normalized);
    if (matched) {
      return { id: matched.id, name: matched.name };
    }
  } catch (error) {
    console.warn("failed to resolve account by text", error instanceof Error ? error.message : String(error));
  }

  return {};
}

function addPendingReviewFromDraft(
  store: StoreLike,
  draft: BookkeepingDraft,
  config: AppConfig,
  transaction: ParsedTransaction,
  result: EzBookkeepingResult,
): void {
  store.addPendingReview({
    updateId: draft.sourceUpdateId,
    userId: draft.userId,
    chatId: draft.chatId,
    text: `Draft ${draft.draftId} confirm failure`,
    reason: result.error || "ezbookkeeping_write_failed",
    payload: {
      draft: {
        draftId: draft.draftId,
        type: draft.type,
        amount: draft.amount,
        currency: draft.currency || config.defaultCurrency,
        transactionDate: draft.transactionDate,
      },
      parsed: transaction,
      result,
    },
  });
}

function safeStoreFn<T>(fn: ((...args: any[]) => T) | undefined) {
  return fn || (() => undefined as unknown as T);
}

export async function handleTelegramUpdate(
  update: unknown,
  config: AppConfig,
  store: StoreLike,
  options: {
    fetchImpl?: typeof fetch;
    writeTransactionImpl?: typeof writeTransaction;
  } = {},
): Promise<TelegramUpdateResult> {
  const message = extractTelegramMessage(update);
  if (!message) {
    return { status: "failed", message: "Unsupported Telegram update" };
  }

  const fetchImpl = options.fetchImpl || fetch;
  const writeTransactionImpl = options.writeTransactionImpl || writeTransaction;
  const effectiveConfig = configWithStoreAliases(config, store);

  if (store.isProcessed(message.updateId)) {
    return { status: "duplicate", message: "Duplicate update ignored" };
  }

  store.expireOutdatedDrafts?.();

  if (!config.telegramAllowedUserIds.has(message.userId)) {
    store.markProcessed(message.updateId, "unauthorized");
    await sendTelegramMessage(
      config,
      message.chatId,
      "未授權的使用者。",
      fetchImpl,
    );
    return { status: "unauthorized", message: "Unauthorized user rejected" };
  }

  const callback = message.callbackQueryId ? parseCallbackData(message.text) : undefined;
  const activeDraft = store.getActiveDraft?.(message.userId, message.chatId);

  if (message.callbackQueryId && callback === undefined) {
    await answerCallbackQuery(
      config,
      message.callbackQueryId,
      "無效的按鈕回應，請重新整理操作。",
      fetchImpl,
    );
    store.markProcessed(message.updateId, "callback_parse_failed");
    return { status: "failed", message: "Unsupported callback data" };
  }

  if (callback) {
    const draft = callback.draftId ? activeDraft && callback.draftId === activeDraft.draftId ? activeDraft : store.getDraft?.(callback.draftId) : undefined;
    const onCallbackError = async (text: string) => {
      await answerCallbackQuery(config, message.callbackQueryId, text, fetchImpl);
      store.markProcessed(message.updateId, "callback_unsupported");
    };

    if (!draft) {
      await onCallbackError("找不到可用的草稿，請重開新輸入。");
      return { status: "failed", message: "Draft not found for callback" };
    }

    if (draft.userId !== message.userId || draft.chatId !== message.chatId) {
      await onCallbackError("無法操作其他用戶的草稿。");
      return { status: "unauthorized", message: "Callback from unauthorized user for draft" };
    }

    if (draft.status !== "active" || isDraftExpired(draft)) {
      await onCallbackError("這個草稿已失效，請重新輸入。");
      if (draft.status === "active") {
        store.failBookkeepingDraft?.(draft.draftId, "expired");
      }
      return { status: "failed", message: "Draft not active/expired for callback" };
    }

    if (!isActionAllowedForDraftStep(draft.step, callback.action as DraftCallbackAction, draft)) {
      await onCallbackError("目前畫面不支援這個操作。");
      return { status: "failed", message: "Unsupported action for current draft step" };
    }

    try {
      if (callback.action === "set_type") {
        const requested = callback.value;
        if (!requested || !["expense", "income", "transfer"].includes(requested)) {
          await onCallbackError("無效的交易類型。");
          return { status: "failed", message: "Unsupported draft type callback" };
        }
        const normalized = requested as TransactionType;
        store.updateBookkeepingDraft?.(draft.draftId, {
          type: normalized,
          fromAccountId: normalized === "transfer" ? undefined : draft.fromAccountId,
          fromAccountName: normalized === "transfer" ? undefined : draft.fromAccountName,
          toAccountId: normalized === "transfer" ? undefined : draft.toAccountId,
          toAccountName: normalized === "transfer" ? undefined : draft.toAccountName,
        });
        const latest = nextDraftStep({
          ...draft,
          type: normalized,
          fromAccountId: undefined,
          fromAccountName: undefined,
          toAccountId: undefined,
          toAccountName: undefined,
        });
        await answerCallbackQuery(config, message.callbackQueryId, "已更新交易類型。", fetchImpl);
        await renderDraftPrompt(config, nextDraftStep(latest), fetchImpl, message.callbackMessageId);
        store.markProcessed(message.updateId, "callback_set_type");
        return { status: "accepted", message: "Draft type updated" };
      }

      if (callback.action === "set_date") {
        const value = callback.value || "";
        const target = value === "custom" ? value : parseQuickDateInput(value, new Date(), config.timezone || "Asia/Taipei");
        if (!target) {
          await onCallbackError("無效的日期，請輸入 YYYY-MM-DD / 今天 / 昨天 / 前天。");
          return { status: "failed", message: "Invalid date input callback" };
        }
        const normalized = target === "custom" ? draft.transactionDate : target;
        if (target === "custom") {
          await store.updateBookkeepingDraft?.(draft.draftId, { step: "date" });
          await answerCallbackQuery(config, message.callbackQueryId, "請輸入自訂日期。", fetchImpl);
          await renderDraftPrompt(config, { ...draft, step: "date" }, fetchImpl, message.callbackMessageId);
          store.markProcessed(message.updateId, "callback_set_date_custom");
          return { status: "accepted", message: "Request custom date input" };
        }
        const updated = nextDraftStep({
          ...draft,
          transactionDate: normalized,
        });
        store.updateBookkeepingDraft?.(draft.draftId, {
          transactionDate: normalized,
          step: updated.step,
        });
        await answerCallbackQuery(config, message.callbackQueryId, "已更新交易日期。", fetchImpl);
        await renderDraftPrompt(config, updated, fetchImpl, message.callbackMessageId);
        store.markProcessed(message.updateId, "callback_set_date");
        return { status: "accepted", message: "Draft date updated" };
      }

      if (callback.action === "set_amount") {
        await answerCallbackQuery(config, message.callbackQueryId, "請輸入數字金額。", fetchImpl);
        store.updateBookkeepingDraft?.(draft.draftId, { step: "amount" });
        await renderDraftPrompt(config, nextDraftStep({ ...draft, step: "amount" }), fetchImpl, message.callbackMessageId);
        store.markProcessed(message.updateId, "callback_set_amount");
        return { status: "accepted", message: "Prompt amount edit" };
      }

      if (callback.action === "select_category" || callback.action === "set_category") {
        if (!callback.value) {
          await onCallbackError("未指定分類。");
          return { status: "failed", message: "Missing category id" };
        }
        const matched = (callback.value && (draft.type === "transfer" ? false : true))
          ? { id: callback.value, name: callback.value }
          : undefined;
        const resolved = matched || (await resolveCategoryFromText(draft, callback.value, effectiveConfig, fetchImpl));
        if (!resolved.id) {
          await onCallbackError("無法辨識分類。");
          return { status: "failed", message: "Category resolution failed" };
        }
        const updated = nextDraftStep({
          ...draft,
          categoryId: resolved.id,
          categoryName: resolved.name || draft.categoryName,
          categoryAlias: callback.value,
          step: "category" as BookkeepingDraftStep,
        });
        store.updateBookkeepingDraft?.(draft.draftId, {
          categoryId: resolved.id,
          categoryName: resolved.name || draft.categoryName,
          categoryAlias: callback.value,
          step: updated.step,
        });
        await answerCallbackQuery(config, message.callbackQueryId, "已選擇分類。", fetchImpl);
        await renderDraftPrompt(config, updated, fetchImpl, message.callbackMessageId);
        store.markProcessed(message.updateId, "callback_select_category");
        return { status: "accepted", message: "Draft category selected" };
      }

      if (callback.action === "select_account" || callback.action === "set_from_account" || callback.action === "set_to_account") {
        if (!callback.value) {
          await onCallbackError("未指定帳戶。");
          return { status: "failed", message: "Missing account id" };
        }
        const accountNames = await resolveAccountFromText(effectiveConfig, callback.value, fetchImpl);
        const update = { ...draft } as BookkeepingDraft;
        const target = callback.action === "set_from_account" ? "from" : callback.action === "set_to_account" ? "to" : "single";
        if (target === "from") {
          update.fromAccountId = callback.value;
          update.fromAccountName = accountNames.name;
          update.step = draftNeeds({ ...update, fromAccountId: callback.value }).step;
        } else if (target === "to") {
          update.toAccountId = callback.value;
          update.toAccountName = accountNames.name;
          update.step = draftNeeds({ ...update, toAccountId: callback.value }).step;
        } else {
          update.accountId = callback.value;
          update.accountName = accountNames.name;
          update.accountAlias = accountNames.alias;
          update.step = draftNeeds({ ...update, accountId: callback.value }).step;
        }
        store.updateBookkeepingDraft?.(draft.draftId, {
          accountId: update.accountId,
          accountName: update.accountName,
          accountAlias: update.accountAlias,
          fromAccountId: update.fromAccountId,
          fromAccountName: update.fromAccountName,
          toAccountId: update.toAccountId,
          toAccountName: update.toAccountName,
          step: update.step,
        });
        await answerCallbackQuery(config, message.callbackQueryId, "已選擇帳戶。", fetchImpl);
        await renderDraftPrompt(config, nextDraftStep(update), fetchImpl, message.callbackMessageId);
        store.markProcessed(message.updateId, "callback_select_account");
        return { status: "accepted", message: "Draft account selected" };
      }

      if (callback.action === "page_category" || callback.action === "page_account") {
        const pageValue = parseInt(callback.value || "0", 10);
        const pageDraft = nextDraftStep(draft);
        await answerCallbackQuery(config, message.callbackQueryId, "切換頁面。", fetchImpl);
        await renderDraftPrompt(config, pageDraft, fetchImpl, message.callbackMessageId, pageValue, { mode: "markup-only" });
        store.markProcessed(message.updateId, "callback_page");
        return { status: "accepted", message: "Draft page changed" };
      }

      if (callback.action === "back") {
        const previousStep = previousDraftStep(draft);
        if (!previousStep) {
          await onCallbackError("已到達起始步驟。");
          return { status: "failed", message: "Cannot go back from current draft step" };
        }
        const reverted = { ...draft, step: previousStep };
        await store.updateBookkeepingDraft?.(draft.draftId, { step: previousStep });
        await answerCallbackQuery(config, message.callbackQueryId, "已回上一步。", fetchImpl);
        await renderDraftPrompt(config, reverted, fetchImpl, message.callbackMessageId);
        store.markProcessed(message.updateId, "callback_back");
        return { status: "accepted", message: "Draft back navigation" };
      }

      if (callback.action === "edit_type") {
        await store.updateBookkeepingDraft?.(draft.draftId, { step: "type" });
        await answerCallbackQuery(config, message.callbackQueryId, "請編輯交易類型。", fetchImpl);
        await renderDraftPrompt(config, nextDraftStep({ ...draft, step: "type" }), fetchImpl, message.callbackMessageId);
        store.markProcessed(message.updateId, "callback_edit_type");
        return { status: "accepted", message: "Draft edit type" };
      }
      if (callback.action === "edit_date") {
        await store.updateBookkeepingDraft?.(draft.draftId, { step: "date" });
        await answerCallbackQuery(config, message.callbackQueryId, "請編輯日期。", fetchImpl);
        await renderDraftPrompt(config, nextDraftStep({ ...draft, step: "date" }), fetchImpl, message.callbackMessageId);
        store.markProcessed(message.updateId, "callback_edit_date");
        return { status: "accepted", message: "Draft edit date" };
      }
      if (callback.action === "edit_amount") {
        await store.updateBookkeepingDraft?.(draft.draftId, { step: "amount" });
        await answerCallbackQuery(config, message.callbackQueryId, "請輸入金額。", fetchImpl);
        await renderDraftPrompt(config, nextDraftStep({ ...draft, step: "amount" }), fetchImpl, message.callbackMessageId);
        store.markProcessed(message.updateId, "callback_edit_amount");
        return { status: "accepted", message: "Draft edit amount" };
      }
      if (callback.action === "edit_category") {
        await store.updateBookkeepingDraft?.(draft.draftId, { step: "category" });
        await answerCallbackQuery(config, message.callbackQueryId, "請輸入或選擇分類。", fetchImpl);
        await renderDraftPrompt(config, nextDraftStep({ ...draft, step: "category" }), fetchImpl, message.callbackMessageId);
        store.markProcessed(message.updateId, "callback_edit_category");
        return { status: "accepted", message: "Draft edit category" };
      }
      if (callback.action === "edit_account") {
        await store.updateBookkeepingDraft?.(draft.draftId, { step: "account" });
        await answerCallbackQuery(config, message.callbackQueryId, "請輸入或選擇帳戶。", fetchImpl);
        await renderDraftPrompt(config, nextDraftStep({ ...draft, step: "account" }), fetchImpl, message.callbackMessageId);
        store.markProcessed(message.updateId, "callback_edit_account");
        return { status: "accepted", message: "Draft edit account" };
      }
      if (callback.action === "edit_from_account") {
        await store.updateBookkeepingDraft?.(draft.draftId, { step: "from_account" });
        await answerCallbackQuery(config, message.callbackQueryId, "請輸入轉帳來源帳戶。", fetchImpl);
        await renderDraftPrompt(config, nextDraftStep({ ...draft, step: "from_account" }), fetchImpl, message.callbackMessageId);
        store.markProcessed(message.updateId, "callback_edit_from_account");
        return { status: "accepted", message: "Draft edit from account" };
      }
      if (callback.action === "edit_to_account") {
        await store.updateBookkeepingDraft?.(draft.draftId, { step: "to_account" });
        await answerCallbackQuery(config, message.callbackQueryId, "請輸入轉帳目標帳戶。", fetchImpl);
        await renderDraftPrompt(config, nextDraftStep({ ...draft, step: "to_account" }), fetchImpl, message.callbackMessageId);
        store.markProcessed(message.updateId, "callback_edit_to_account");
        return { status: "accepted", message: "Draft edit to account" };
      }
      if (callback.action === "edit_note") {
        await store.updateBookkeepingDraft?.(draft.draftId, { step: "note" });
        await answerCallbackQuery(config, message.callbackQueryId, "請輸入備註。", fetchImpl);
        await renderDraftPrompt(config, nextDraftStep({ ...draft, step: "note" }), fetchImpl, message.callbackMessageId);
        store.markProcessed(message.updateId, "callback_edit_note");
        return { status: "accepted", message: "Draft edit note" };
      }

      if (callback.action === "new_category") {
        await store.updateBookkeepingDraft?.(draft.draftId, { step: "new_category_name", createCategoryType: draft.type });
        await answerCallbackQuery(config, message.callbackQueryId, "請輸入新分類名稱。", fetchImpl);
        await renderDraftPrompt(config, nextDraftStep({ ...draft, step: "new_category_name", createCategoryType: draft.type }), fetchImpl, message.callbackMessageId);
        store.markProcessed(message.updateId, "callback_new_category");
        return { status: "accepted", message: "Draft new category name" };
      }

      if (callback.action === "new_category_confirm") {
        const nextDraft: DraftFlowState = {
          ...draft,
          step: "new_category_confirm",
          createCategoryParent: draft.createCategoryParent || "Miscellaneous",
        };
        await store.updateBookkeepingDraft?.(draft.draftId, {
          step: "new_category_confirm",
          createCategoryParent: draft.createCategoryParent || "Miscellaneous",
        });
        await answerCallbackQuery(config, message.callbackQueryId, "請確認新分類。", fetchImpl);
        await renderDraftPrompt(config, nextDraft, fetchImpl, message.callbackMessageId);
        store.markProcessed(message.updateId, "callback_new_category_confirm");
        return { status: "accepted", message: "Draft new category confirm" };
      }

      if (callback.action === "create_category") {
        if (callback.value === "cancel") {
          await store.updateBookkeepingDraft?.(draft.draftId, { step: draftNeeds(draft).step });
          await answerCallbackQuery(config, message.callbackQueryId, "已取消新分類。", fetchImpl);
          await renderDraftPrompt(config, nextDraftStep(draft), fetchImpl, message.callbackMessageId);
          store.markProcessed(message.updateId, "callback_create_category_cancel");
          return { status: "accepted", message: "Draft category creation cancelled" };
        }
        if (callback.value !== "confirm" && callback.value !== "only") {
          await onCallbackError("無效的新分類操作。");
          return { status: "failed", message: "Unsupported create category action" };
        }
        if (!draft.createCategoryName) {
          await onCallbackError("請先輸入新分類名稱。");
          return { status: "failed", message: "Missing new category name" };
        }
        try {
          const saved = await saveCategoryFromTelegram(
            effectiveConfig,
            store,
            {
              categoryType: draft.createCategoryType || draft.type,
              name: draft.createCategoryName,
              parentName: draft.createCategoryParent || "Miscellaneous",
              alias: draft.createCategoryName,
            },
            fetchImpl,
          );
          const shouldUseInDraft = callback.value === "confirm";
          const updated = nextDraftStep({
            ...draft,
            categoryId: shouldUseInDraft ? saved.categoryId : draft.categoryId,
            categoryName: shouldUseInDraft ? saved.categoryName : draft.categoryName,
            categoryAlias: shouldUseInDraft ? saved.alias : draft.categoryAlias,
            step: "category",
          });
          store.updateBookkeepingDraft?.(draft.draftId, {
            categoryId: shouldUseInDraft ? saved.categoryId : draft.categoryId,
            categoryName: shouldUseInDraft ? saved.categoryName : draft.categoryName,
            categoryAlias: shouldUseInDraft ? saved.alias : draft.categoryAlias,
            createCategoryName: undefined,
            createCategoryParent: undefined,
            createCategoryType: undefined,
            step: updated.step,
          });
          if (shouldUseInDraft) {
            await answerCallbackQuery(config, message.callbackQueryId, "已建立分類並套用。", fetchImpl);
          } else {
            await answerCallbackQuery(config, message.callbackQueryId, "已建立分類，未套用草稿。", fetchImpl);
          }
          await renderDraftPrompt(config, updated, fetchImpl, message.callbackMessageId);
          store.markProcessed(
            message.updateId,
            shouldUseInDraft ? "callback_create_category" : "callback_create_category_only",
          );
          return {
            status: "accepted",
            message: shouldUseInDraft ? "Draft category created and used" : "Draft category created only",
          };
        } catch (error) {
          await store.failBookkeepingDraft?.(draft.draftId, "category_creation_failed");
          await onCallbackError(`建立失敗：${error instanceof Error ? error.message : String(error)}`);
          return { status: "failed", message: "Category creation failed" };
        }
      }

      if (callback.action === "confirm") {
        if (!draftIsReadyToConfirm(draft)) {
          await onCallbackError("草稿尚未完成。");
          return { status: "failed", message: "Draft not ready for confirm" };
        }
        if (draft.status !== "active") {
          await onCallbackError("這筆草稿已處理。");
          return { status: "failed", message: "Draft already handled" };
        }
        const transaction = draftToParsedTransaction(nextDraftStep(draft), effectiveConfig.defaultCurrency);
        const result = await writeTransactionImpl(effectiveConfig, transaction, fetchImpl);
        if (!result.ok) {
          const currentDraft = store.failBookkeepingDraft;
          if (currentDraft) {
            currentDraft(draft.draftId, result.error || "ezbookkeeping_write_failed");
          }
          await addPendingReviewFromDraft(store, draft, effectiveConfig, transaction, result);
          await answerCallbackQuery(config, message.callbackQueryId, "寫入失敗，已加入待處理。", fetchImpl);
          store.markProcessed(message.updateId, "callback_confirm_failed");
          return { status: "pending_review", message: "Draft confirmed failed" };
        }
        store.confirmBookkeepingDraft?.(draft.draftId, result.transactionId || "manual");
        await answerCallbackQuery(config, message.callbackQueryId, "記帳完成。", fetchImpl);
        await sendTelegramMessage(config, draft.chatId, `✅ 已記帳：${draftTypeLabel(draft.type)} ${draft.currency || effectiveConfig.defaultCurrency} ${formatDraftAmount(draft.amount || 0)}`, fetchImpl);
        store.markProcessed(message.updateId, "callback_confirm");
        return { status: "accepted", message: "Draft confirmed" };
      }

      if (callback.action === "cancel") {
        await store.cancelBookkeepingDraft?.(draft.draftId, "cancelled_by_user");
        await answerCallbackQuery(config, message.callbackQueryId, "已取消草稿。", fetchImpl);
        store.markProcessed(message.updateId, "callback_cancel");
        await sendTelegramMessage(config, draft.chatId, "已取消草稿。", fetchImpl);
        return { status: "accepted", message: "Draft cancelled" };
      }

      await onCallbackError("不支援的按鈕。");
      return { status: "failed", message: "Unsupported callback action" };
    } catch (error) {
      await onCallbackError(`操作失敗：${error instanceof Error ? error.message : String(error)}`);
      return { status: "failed", message: "Draft callback failed" };
    }
  }

  const parsed = parseMessage(message.text, new Date(), {
    defaultCurrency: effectiveConfig.defaultCurrency,
    defaultExpenseAccount: effectiveConfig.defaultExpenseAccount,
    defaultIncomeAccount: effectiveConfig.defaultIncomeAccount,
    knownAccounts: Object.keys(effectiveConfig.ezBookkeepingAccountIds),
  });

  const activeDraftText = activeDraft && !isSlashCommand(message.text) && parsed.kind !== "transaction";
  if (activeDraftText) {
    if (parsed.kind === "quick_sentence") {
      await sendTelegramMessage(
        config,
        message.chatId,
        "目前有未完成的草稿，請先完成或取消目前草稿。",
        fetchImpl,
      );
      await renderDraftPrompt(config, activeDraft, fetchImpl, message.callbackMessageId);
      store.markProcessed(message.updateId, "draft_blocked_by_active");
      return { status: "failed", message: "Active draft blocks quick sentence" };
    }
    if (activeDraft && isDraftExpired(activeDraft)) {
      await store.failBookkeepingDraft?.(activeDraft.draftId, "expired");
      store.markProcessed(message.updateId, "active_draft_expired");
      await sendTelegramMessage(config, message.chatId, "目前草稿已過期，已關閉。", fetchImpl);
      return { status: "failed", message: "Active draft expired" };
    }
    if (activeDraft) {
      const normalized = message.text.trim();
      if (activeDraft.step === "type") {
        const type = detectTypeFromText(normalized);
        if (type) {
          await store.updateBookkeepingDraft?.(activeDraft.draftId, {
            type,
            step: draftNeeds({ ...activeDraft, type } as BookkeepingDraft).step,
          });
          const refreshed = nextDraftStep({ ...activeDraft, type });
          await sendTelegramMessage(config, message.chatId, `已更新交易類型：${type}`, fetchImpl);
          await renderDraftPrompt(config, refreshed, fetchImpl, message.callbackMessageId);
          store.markProcessed(message.updateId, "draft_type_from_text");
          return { status: "accepted", message: "Draft type updated by text" };
        }
      }
      if (activeDraft.step === "amount") {
        const amount = parseAmountValue(normalized);
        if (amount) {
          const refreshed = nextDraftStep({ ...activeDraft, amount, step: "amount" });
          store.updateBookkeepingDraft?.(activeDraft.draftId, { amount, step: refreshed.step });
          await sendTelegramMessage(config, message.chatId, "已更新金額。", fetchImpl);
          await renderDraftPrompt(config, refreshed, fetchImpl, message.callbackMessageId);
          store.markProcessed(message.updateId, "draft_amount_from_text");
          return { status: "accepted", message: "Draft amount updated by text" };
        }
      }
      if (activeDraft.step === "date") {
        const parsedDate = parseQuickDateInput(normalized, new Date(), config.timezone || "Asia/Taipei");
        if (parsedDate) {
          const refreshed = nextDraftStep({ ...activeDraft, transactionDate: parsedDate, step: "date" });
          store.updateBookkeepingDraft?.(activeDraft.draftId, { transactionDate: parsedDate, step: refreshed.step });
          await sendTelegramMessage(config, message.chatId, "已更新日期。", fetchImpl);
          await renderDraftPrompt(config, refreshed, fetchImpl, message.callbackMessageId);
          store.markProcessed(message.updateId, "draft_date_from_text");
          return { status: "accepted", message: "Draft date updated by text" };
        }
      }
      if (activeDraft.step === "note") {
        const refreshed = nextDraftStep({ ...activeDraft, note: normalized, step: "note" });
        store.updateBookkeepingDraft?.(activeDraft.draftId, { note: normalized, step: refreshed.step });
        await sendTelegramMessage(config, message.chatId, "已更新備註。", fetchImpl);
        await renderDraftPrompt(config, refreshed, fetchImpl, message.callbackMessageId);
        store.markProcessed(message.updateId, "draft_note_from_text");
        return { status: "accepted", message: "Draft note updated by text" };
      }
      if (activeDraft.step === "confirm") {
        const refreshed = nextDraftStep({ ...activeDraft, note: normalized, step: "confirm" });
        store.updateBookkeepingDraft?.(activeDraft.draftId, { note: normalized, step: refreshed.step });
        await sendTelegramMessage(config, message.chatId, "已更新備註。", fetchImpl);
        await renderDraftPrompt(config, refreshed, fetchImpl, message.callbackMessageId);
        store.markProcessed(message.updateId, "draft_note_from_confirm_text");
        return { status: "accepted", message: "Draft note updated from confirm text" };
      }
      if (activeDraft.step === "category") {
        const resolved = await resolveCategoryFromText(activeDraft, normalized, effectiveConfig, fetchImpl);
        if (!resolved.id) {
          await sendTelegramMessage(config, message.chatId, "無法辨識分類名稱，請用清單中的項目。", fetchImpl);
          return { status: "failed", message: "Unknown category text" };
        }
        const refreshed = nextDraftStep({
          ...activeDraft,
          categoryId: resolved.id,
          categoryName: resolved.name || activeDraft.categoryName,
          categoryAlias: resolved.id,
        });
        store.updateBookkeepingDraft?.(activeDraft.draftId, {
          categoryId: resolved.id,
          categoryName: resolved.name || activeDraft.categoryName,
          categoryAlias: resolved.id,
          step: refreshed.step,
        });
        await sendTelegramMessage(config, message.chatId, "已更新分類。", fetchImpl);
        await renderDraftPrompt(config, refreshed, fetchImpl, message.callbackMessageId);
        store.markProcessed(message.updateId, "draft_category_from_text");
        return { status: "accepted", message: "Draft category updated by text" };
      }
      if (activeDraft.step === "account") {
        const resolved = await resolveAccountFromText(effectiveConfig, normalized, fetchImpl);
        if (!resolved.id) {
          await sendTelegramMessage(config, message.chatId, "無法辨識帳戶名稱，請用清單中的項目。", fetchImpl);
          return { status: "failed", message: "Unknown account text" };
        }
        const refreshed = nextDraftStep({
          ...activeDraft,
          accountId: resolved.id,
          accountName: resolved.name,
          accountAlias: resolved.alias,
        });
        store.updateBookkeepingDraft?.(activeDraft.draftId, {
          accountId: resolved.id,
          accountName: resolved.name,
          accountAlias: resolved.alias,
          step: refreshed.step,
        });
        await sendTelegramMessage(config, message.chatId, "已更新帳戶。", fetchImpl);
        await renderDraftPrompt(config, refreshed, fetchImpl, message.callbackMessageId);
        store.markProcessed(message.updateId, "draft_account_from_text");
        return { status: "accepted", message: "Draft account updated by text" };
      }
      if (activeDraft.step === "from_account") {
        const resolved = await resolveAccountFromText(effectiveConfig, normalized, fetchImpl);
        if (!resolved.id) {
          await sendTelegramMessage(config, message.chatId, "無法辨識帳戶名稱，請用清單中的項目。", fetchImpl);
          return { status: "failed", message: "Unknown from account text" };
        }
        const refreshed = nextDraftStep({
          ...activeDraft,
          fromAccountId: resolved.id,
          fromAccountName: resolved.name,
        });
        store.updateBookkeepingDraft?.(activeDraft.draftId, {
          fromAccountId: resolved.id,
          fromAccountName: resolved.name,
          step: refreshed.step,
        });
        await sendTelegramMessage(config, message.chatId, "已更新來源帳戶。", fetchImpl);
        await renderDraftPrompt(config, refreshed, fetchImpl, message.callbackMessageId);
        store.markProcessed(message.updateId, "draft_from_account_from_text");
        return { status: "accepted", message: "Draft from account updated by text" };
      }
      if (activeDraft.step === "to_account") {
        const resolved = await resolveAccountFromText(effectiveConfig, normalized, fetchImpl);
        if (!resolved.id) {
          await sendTelegramMessage(config, message.chatId, "無法辨識帳戶名稱，請用清單中的項目。", fetchImpl);
          return { status: "failed", message: "Unknown to account text" };
        }
        const refreshed = nextDraftStep({
          ...activeDraft,
          toAccountId: resolved.id,
          toAccountName: resolved.name,
        });
        store.updateBookkeepingDraft?.(activeDraft.draftId, {
          toAccountId: resolved.id,
          toAccountName: resolved.name,
          step: refreshed.step,
        });
        await sendTelegramMessage(config, message.chatId, "已更新目標帳戶。", fetchImpl);
        await renderDraftPrompt(config, refreshed, fetchImpl, message.callbackMessageId);
        store.markProcessed(message.updateId, "draft_to_account_from_text");
        return { status: "accepted", message: "Draft to account updated by text" };
      }
      if (activeDraft.step === "new_category_name") {
        const updated: DraftFlowState = {
          ...activeDraft,
          createCategoryName: normalized,
          step: "new_category_parent",
        };
        store.updateBookkeepingDraft?.(activeDraft.draftId, {
          createCategoryName: normalized,
          step: "new_category_parent",
          createCategoryType: activeDraft.createCategoryType || activeDraft.type,
          createCategoryParent: activeDraft.createCategoryParent,
        });
        await sendTelegramMessage(config, message.chatId, "已更新新分類名稱，請輸入上層分類（或直接回傳 default）。", fetchImpl);
        await renderDraftPrompt(config, updated, fetchImpl, message.callbackMessageId);
        store.markProcessed(message.updateId, "draft_new_category_name");
        return { status: "accepted", message: "Draft new category name updated" };
      }
      if (activeDraft.step === "new_category_parent") {
        const updated: DraftFlowState = {
          ...activeDraft,
          createCategoryParent: normalized === "default" ? "Miscellaneous" : normalized,
          step: "new_category_confirm",
        };
        store.updateBookkeepingDraft?.(activeDraft.draftId, {
          createCategoryParent: updated.createCategoryParent,
          step: "new_category_confirm",
        });
        await sendTelegramMessage(config, message.chatId, "已更新上層分類，請確認。", fetchImpl);
        await renderDraftPrompt(config, updated, fetchImpl, message.callbackMessageId);
        store.markProcessed(message.updateId, "draft_new_category_parent");
        return { status: "accepted", message: "Draft new category parent updated" };
      }
      store.markProcessed(message.updateId, "draft_unknown_reply");
      await sendTelegramMessage(config, message.chatId, "目前草稿步驟不支援這段文字。", fetchImpl);
      return { status: "failed", message: "Draft text not handled" };
    }
  }

  if (activeDraft && parsed.kind === "quick_sentence") {
    await sendTelegramMessage(
      config,
      message.chatId,
      "目前有未完成的草稿，請先完成或取消目前草稿。",
      fetchImpl,
    );
    await renderDraftPrompt(config, activeDraft, fetchImpl, message.callbackMessageId);
    store.markProcessed(message.updateId, "draft_blocked_by_active");
    return { status: "failed", message: "Active draft blocks quick sentence" };
  }

  if (parsed.kind === "quick_sentence") {
    if (activeDraft) {
      await sendTelegramMessage(
        config,
        message.chatId,
        "目前有未完成的草稿，請先完成或取消目前草稿。",
        fetchImpl,
      );
      store.markProcessed(message.updateId, "draft_blocked_by_active");
      return { status: "failed", message: "Active draft blocks new draft start" };
    }

    const draftTemplate = createDraftFromQuickSentence(effectiveConfig, message, parsed.quickSentence);
    const draft = nextDraftStep({
      ...draftTemplate,
      draftId: draftTemplate.draftId,
      userId: message.userId,
      chatId: message.chatId,
      sourceUpdateId: message.updateId,
      status: "active",
      currency: draftTemplate.currency || effectiveConfig.defaultCurrency,
      step: draftTemplate.step,
      type: draftTemplate.type,
      expiresAt: draftExpiry(),
    });
    if (!store.createBookkeepingDraft) {
      store.markProcessed(message.updateId, "draft_create_unsupported");
      return { status: "failed", message: "Draft store not ready" };
    }
    store.createBookkeepingDraft(draft);
    const current = store.getDraft?.(draft.draftId);
    if (current) {
      await renderDraftPrompt(config, current, fetchImpl, message.callbackMessageId);
    } else {
      await sendTelegramMessage(
        config,
        message.chatId,
        createDraftSummaryLine({ ...draft, status: "active", sourceUpdateId: message.updateId }),
      );
    }
    store.markProcessed(message.updateId, "draft_started");
    return { status: "accepted", message: "Started bookkeeping draft" };
  }

  if (parsed.kind === "status") {
    store.markProcessed(message.updateId, "status");
    await sendTelegramMessage(
      config,
      message.chatId,
      `FinOps 就緒｜待審 ${store.pendingReviewCount()} 筆。`,
      fetchImpl,
    );
    return { status: "accepted", message: "Status sent" };
  }

  if (parsed.kind === "help") {
    store.markProcessed(message.updateId, "help");
    await sendTelegramMessage(
      config,
      message.chatId,
      [
        "<b>FinOps 指令</b>",
        "",
        "📝 <b>快速記帳</b>",
        "expense &lt;amount&gt; [currency] &lt;category&gt; &lt;account&gt;",
        "income &lt;amount&gt; [currency] &lt;category&gt; &lt;account&gt;",
        "transfer &lt;amount&gt; &lt;currency&gt; from &lt;account&gt; to &lt;account&gt;",
        "",
        "📊 <b>查詢</b>",
        "status｜overview today|7d|month",
        "categories [expense|income|transfer]｜accounts",
        "",
        "🛠 <b>分類管理</b>",
        "category add &lt;expense|income|transfer&gt; &lt;name&gt; [under &lt;parent&gt;] [alias &lt;alias&gt;]",
        "category confirm &lt;update_id&gt; [under &lt;parent&gt;] [alias &lt;alias&gt;]",
      ].join("\n"),
      fetchImpl,
    );
    return { status: "accepted", message: "Help sent" };
  }

  if (parsed.kind === "cancel") {
    if (activeDraft) {
      await store.cancelBookkeepingDraft?.(activeDraft.draftId, "cancelled_by_user_command");
      store.markProcessed(message.updateId, "cancel_draft");
      await sendTelegramMessage(
        config,
        message.chatId,
        "已取消目前草稿。",
        fetchImpl,
      );
      return { status: "accepted", message: "Active draft cancelled" };
    }

    store.markProcessed(message.updateId, "cancel_no_active_draft");
    await sendTelegramMessage(
      config,
      message.chatId,
      "目前沒有可取消的草稿。",
      fetchImpl,
    );
    return { status: "accepted", message: "No active draft to cancel" };
  }

  if (parsed.kind === "overview") {
    const overview = await generateSpendingOverview(
      config,
      {
        pendingReviewCount: () => store.pendingReviewCount(),
        recordReport: () => undefined,
      },
      parsed.period,
      fetchImpl,
    );
    store.markProcessed(message.updateId, `overview_${overview.status}`);
    await sendTelegramMessage(
      config,
      message.chatId,
      overview.text.slice(0, 3500),
      fetchImpl,
    );
    return { status: "accepted", message: "Overview sent" };
  }

  if (parsed.kind === "categories") {
    let text: string;
    try {
      text = await formatCategoriesMessage(effectiveConfig, store, parsed.categoryType, fetchImpl);
    } catch (error) {
      console.warn("category list failed", error instanceof Error ? error.message : String(error));
      text = fallbackAliasList("已設定的分類別名", effectiveConfig.ezBookkeepingCategoryIds);
    }

    store.markProcessed(message.updateId, "categories");
    await sendTelegramMessage(config, message.chatId, text.slice(0, 3500), fetchImpl);
    return { status: "accepted", message: "Categories sent" };
  }

  if (parsed.kind === "accounts") {
    let text: string;
    try {
      text = await formatAccountsMessage(effectiveConfig, fetchImpl);
    } catch (error) {
      console.warn("account list failed", error instanceof Error ? error.message : String(error));
      text = fallbackAliasList("已設定的帳戶別名", effectiveConfig.ezBookkeepingAccountIds);
    }

    store.markProcessed(message.updateId, "accounts");
    await sendTelegramMessage(config, message.chatId, text.slice(0, 3500), fetchImpl);
    return { status: "accepted", message: "Accounts sent" };
  }

  if (parsed.kind === "category_add") {
    try {
      const category = await saveCategoryFromTelegram(effectiveConfig, store, parsed, fetchImpl);
      store.markProcessed(message.updateId, "category_added");
      await sendTelegramMessage(
        config,
        message.chatId,
        [
          `✅ 分類已就緒：${typeLabel(parsed.categoryType)} / ${escapeHtml(category.categoryName)}`,
          `別名：${escapeHtml(category.alias)}`,
          `試試：${parsed.categoryType} 80 ${effectiveConfig.defaultCurrency} ${escapeHtml(category.alias)} cash`,
        ].join("\n"),
        fetchImpl,
      );
      return { status: "accepted", message: "Category added" };
    } catch (error) {
      store.addPendingReview({
        ...pendingBase(message),
        reason: "category_add_failed",
        payload: { parsed, error: error instanceof Error ? error.message : String(error) },
      });
      store.markProcessed(message.updateId, "pending_category_add_failed");
      await sendTelegramMessage(
        config,
        message.chatId,
        `⚠️ 新增分類失敗，已存入待審：${escapeHtml(error instanceof Error ? error.message : String(error))}`,
        fetchImpl,
      );
      return { status: "pending_review", message: "Category add failed" };
    }
  }

  if (parsed.kind === "category_confirm") {
    const pending = store.getPendingReviewByUpdateId?.(parsed.updateId);
    const pendingPayload = pending?.payload as { parsed?: { transaction?: ParsedTransaction } } | undefined;
    const transaction = pendingPayload?.parsed?.transaction;

    if (!pending || !transaction?.category) {
      store.markProcessed(message.updateId, "category_confirm_missing_pending");
      await sendTelegramMessage(
        config,
        message.chatId,
        `找不到 update ${parsed.updateId} 對應的待審交易。`,
        fetchImpl,
      );
      return { status: "failed", message: "Pending transaction not found" };
    }

    try {
      const categoryType = transactionCategoryType(transaction.type);
      const category = await saveCategoryFromTelegram(
        effectiveConfig,
        store,
        {
          categoryType,
          name: transaction.category,
          parentName: parsed.parentName,
          alias: parsed.alias || transaction.category,
        },
        fetchImpl,
      );
      const retryConfig = {
        ...effectiveConfig,
        ezBookkeepingCategoryIds: {
          ...effectiveConfig.ezBookkeepingCategoryIds,
          [category.alias]: category.categoryId,
        },
      };
      const retry = await writeTransactionImpl(retryConfig, transaction, fetchImpl);
      if (!retry.ok) {
        store.markProcessed(message.updateId, "pending_category_confirm_write_failed");
        await sendTelegramMessage(
          config,
          message.chatId,
          "⚠️ 分類已建立，但待審交易仍無法寫入 ezBookkeeping。",
          fetchImpl,
        );
        return { status: "pending_review", message: "Category created but retry failed" };
      }

      store.resolvePendingReview?.(parsed.updateId);
      store.markProcessed(message.updateId, "category_confirmed");
      await sendTelegramMessage(
        config,
        message.chatId,
        `✅ 已建立分類 ${escapeHtml(category.categoryName)}（別名 ${escapeHtml(category.alias)}），並記錄待審交易。`,
        fetchImpl,
      );
      return { status: "accepted", message: "Category confirmed and transaction recorded" };
    } catch (error) {
      store.markProcessed(message.updateId, "pending_category_confirm_failed");
      await sendTelegramMessage(
        config,
        message.chatId,
        `⚠️ 確認分類失敗：${escapeHtml(error instanceof Error ? error.message : String(error))}`,
        fetchImpl,
      );
      return { status: "pending_review", message: "Category confirmation failed" };
    }
  }

  if (parsed.kind === "correction") {
    store.addPendingReview({
      ...pendingBase(message),
      reason: "correction_requested",
      payload: parsed,
    });
    store.markProcessed(message.updateId, "pending_correction");
    await sendTelegramMessage(
      config,
      message.chatId,
      "已存入待審：更正請求。",
      fetchImpl,
    );
    return {
      status: "pending_review",
      message: "Correction stored for review",
    };
  }

  if (parsed.kind === "ambiguous") {
    store.addPendingReview({
      ...pendingBase(message),
      reason: `missing:${parsed.missing.join(",")}`,
      payload: parsed,
    });
    store.markProcessed(message.updateId, "pending_ambiguous");
    await sendTelegramMessage(
      config,
      message.chatId,
      `需要更多資訊：${escapeHtml(parsed.missing.join("、"))}。`,
      fetchImpl,
    );
    return {
      status: "pending_review",
      message: "Ambiguous message stored for review",
    };
  }

  const categoryValidation = await validateCategoryBeforeWrite(
    effectiveConfig,
    store,
    parsed.transaction,
    fetchImpl,
  );
  if (!categoryValidation.ok) {
    store.addPendingReview({
      ...pendingBase(message),
      reason: categoryValidation.reason,
      payload: { parsed },
    });
    store.markProcessed(message.updateId, "pending_category");
    await sendTelegramMessage(
      config,
      message.chatId,
      categoryValidation.text.replace("<update_id>", String(message.updateId)),
      fetchImpl,
    );
    return {
      status: "pending_review",
      message: "Transaction queued for category confirmation",
    };
  }

  const result: EzBookkeepingResult = await writeTransactionImpl(
    effectiveConfig,
    parsed.transaction,
    fetchImpl,
  );
  if (!result.ok) {
    store.addPendingReview({
      ...pendingBase(message),
      reason: result.error || "ezbookkeeping_write_failed",
      payload: { parsed, result },
    });
    store.markProcessed(message.updateId, "pending_write_failed");
    await sendTelegramMessage(
      config,
      message.chatId,
      "⚠️ ezBookkeeping 寫入失敗，交易已存入待審。",
      fetchImpl,
    );
    return {
      status: "pending_review",
      message: "Write failed and item was queued",
    };
  }

  store.markProcessed(message.updateId, "accepted");
  await sendTelegramMessage(
    config,
    message.chatId,
    `✅ 已記帳：${draftTypeLabel(parsed.transaction.type)} ${parsed.transaction.currency} ${formatDraftAmount(parsed.transaction.amount)}`,
    fetchImpl,
  );
  return { status: "accepted", message: "Transaction recorded" };
}

function pendingBase(
  message: TelegramMessage,
): Omit<PendingReviewItem, "reason" | "payload"> {
  return {
    updateId: message.updateId,
    userId: message.userId,
    chatId: message.chatId,
    text: message.text,
  };
}
