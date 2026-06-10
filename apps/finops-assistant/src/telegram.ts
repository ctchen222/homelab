import {
  AppConfig,
  BookkeepingCategoryType,
  CategoryAliasRecord,
  EzBookkeepingResult,
  PendingReviewItem,
  ParsedTransaction,
  TelegramMessage,
} from "./types";
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
}

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
  };
  const message = candidate.message || candidate.edited_message;
  const updateId = candidate.update_id;
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

export async function sendTelegramMessage(
  config: AppConfig,
  chatId: number | string,
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (!config.telegramBotToken) return false;

  try {
    const response = await fetchImpl(
      `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          disable_web_page_preview: true,
        }),
      },
    );

    if (!response.ok) {
      const body = await response.text().catch(() => "");
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
  if (categoryType === "income") return "Income";
  if (categoryType === "transfer") return "Transfer";
  return "Expense";
}

async function formatCategoriesMessage(
  config: AppConfig,
  store: StoreLike,
  categoryType: BookkeepingCategoryType | undefined,
  fetchImpl: typeof fetch,
): Promise<string> {
  const records = store.categoryAliasRecords?.() || [];
  const categories = await listTransactionCategories(config, categoryType, fetchImpl);
  const lines = [`FinOps categories${categoryType ? ` (${typeLabel(categoryType)})` : ""}:`];
  const flat = flattenCategories(categories).filter((category) => category.parentId !== "0");

  if (flat.length === 0) {
    lines.push("- No leaf categories returned.");
  } else {
    for (const category of flat) {
      const aliases = aliasesForCategory(category.id, records, config.ezBookkeepingCategoryIds);
      lines.push(`- ${category.name}${aliases.length ? `: ${aliases.join(", ")}` : ""}`);
    }
  }

  lines.push("");
  lines.push("Add: category add expense transport under Transportation");
  lines.push("Confirm pending: category confirm <update_id> under Transportation");
  return lines.join("\n");
}

async function formatAccountsMessage(
  config: AppConfig,
  fetchImpl: typeof fetch,
): Promise<string> {
  const accounts = await listAccounts(config, fetchImpl);
  const lines = ["FinOps accounts:"];

  if (accounts.length === 0) {
    lines.push("- No accounts returned.");
  } else {
    for (const account of accounts.filter((item) => !item.hidden)) {
      const aliases = aliasesForAccount(account.id, config.ezBookkeepingAccountIds);
      lines.push(`- ${account.name}${account.currency ? ` (${account.currency})` : ""}${aliases.length ? `: ${aliases.join(", ")}` : ""}`);
    }
  }

  return lines.join("\n");
}

function fallbackAliasList(title: string, aliases: Record<string, string>): string {
  const names = Object.keys(aliases).sort();
  return [title, names.length ? names.map((alias) => `- ${alias}`).join("\n") : "- No aliases configured."].join("\n");
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
        `Unknown ${categoryType} category alias: ${categoryAlias}`,
        `To create it and retry this transaction: category confirm <update_id> under ${categoryType === "expense" ? "Miscellaneous" : "Miscellaneous"}`,
        `Or add only the category: category add ${categoryType} ${categoryAlias}`,
        "Use categories expense|income|transfer to list current categories.",
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
        text: `Category alias "${categoryAlias}" is a ${actualType} category, not ${expectedType}. Use categories ${expectedType} to pick the right category.`,
      };
    }
  } catch {
    return { ok: true };
  }

  return { ok: true };
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

  if (!config.telegramAllowedUserIds.has(message.userId)) {
    store.markProcessed(message.updateId, "unauthorized");
    await sendTelegramMessage(
      config,
      message.chatId,
      "Unauthorized.",
      fetchImpl,
    );
    return { status: "unauthorized", message: "Unauthorized user rejected" };
  }

  const parsed = parseMessage(message.text, new Date(), {
    defaultCurrency: effectiveConfig.defaultCurrency,
    defaultExpenseAccount: effectiveConfig.defaultExpenseAccount,
    defaultIncomeAccount: effectiveConfig.defaultIncomeAccount,
    knownAccounts: Object.keys(effectiveConfig.ezBookkeepingAccountIds),
  });

  if (parsed.kind === "status") {
    store.markProcessed(message.updateId, "status");
    await sendTelegramMessage(
      config,
      message.chatId,
      `FinOps assistant ready. Pending reviews: ${store.pendingReviewCount()}.`,
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
        "FinOps commands:",
        "status",
        "overview today|7d|month",
        "categories [expense|income|transfer]",
        "accounts",
        "category add <expense|income|transfer> <name> [under <parent>] [alias <alias>]",
        "category confirm <update_id> [under <parent>] [alias <alias>]",
        "expense <amount> [currency] <category> <account>",
        "income <amount> [currency] <category> <account>",
        "transfer <amount> <currency> from <account> to <account>",
      ].join("\n"),
      fetchImpl,
    );
    return { status: "accepted", message: "Help sent" };
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
      text = fallbackAliasList("Configured category aliases:", effectiveConfig.ezBookkeepingCategoryIds);
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
      text = fallbackAliasList("Configured account aliases:", effectiveConfig.ezBookkeepingAccountIds);
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
          `Category ready: ${typeLabel(parsed.categoryType)} / ${category.categoryName}`,
          `Alias: ${category.alias}`,
          `Try: ${parsed.categoryType} 80 ${effectiveConfig.defaultCurrency} ${category.alias} cash`,
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
        `Category add failed and was saved for review: ${error instanceof Error ? error.message : String(error)}`,
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
        `No pending transaction found for update ${parsed.updateId}.`,
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
          "Category was created, but the pending transaction still could not be written to ezBookkeeping.",
          fetchImpl,
        );
        return { status: "pending_review", message: "Category created but retry failed" };
      }

      store.resolvePendingReview?.(parsed.updateId);
      store.markProcessed(message.updateId, "category_confirmed");
      await sendTelegramMessage(
        config,
        message.chatId,
        `Category ${category.categoryName} created, alias ${category.alias} saved, and pending transaction recorded.`,
        fetchImpl,
      );
      return { status: "accepted", message: "Category confirmed and transaction recorded" };
    } catch (error) {
      store.markProcessed(message.updateId, "pending_category_confirm_failed");
      await sendTelegramMessage(
        config,
        message.chatId,
        `Category confirmation failed: ${error instanceof Error ? error.message : String(error)}`,
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
      "Correction saved for review.",
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
      `I need more detail: ${parsed.missing.join(", ")}.`,
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
      "Transaction saved for review because ezBookkeeping write failed.",
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
    `Recorded ${parsed.transaction.type} ${parsed.transaction.amount} ${parsed.transaction.currency}.`,
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
