import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AppConfig, SpendingOverviewPeriod } from "./types";
import { escapeHtml, sendTelegramMessage } from "./telegram";

interface StoreLike {
  pendingReviewCount(): number;
  recordReport(reportType: string, status: string, summary: string, artifactPath?: string): void;
}

interface TransactionRecord {
  type?: number;
  time?: number;
  sourceAmount?: number;
  destinationAmount?: number;
  sourceAccountId?: string;
  sourceAccount?: { name?: string };
  destinationAccountId?: string;
  destinationAccount?: { name?: string };
  categoryId?: string;
  category?: { name?: string };
  comment?: string;
}

interface TransactionFetchResult {
  transactions?: TransactionRecord[];
  error?: string;
}

const LARGE_EXPENSE_THRESHOLD = 2000;

interface WatchlistSummary {
  status: "ok" | "partial";
  lines: string[];
}

interface LlmCommentResult {
  comment?: string;
  error?: string;
}

async function fetchEzBookkeepingTransactions(config: AppConfig, fetchImpl: typeof fetch): Promise<TransactionFetchResult> {
  if (!config.ezBookkeepingBaseUrl || !config.ezBookkeepingApiToken) {
    return { error: "ezBookkeeping API token 尚未設定。" };
  }

  try {
    const response = await fetchImpl(`${config.ezBookkeepingBaseUrl.replace(/\/$/, "")}/api/v1/transactions/list/all.json`, {
      headers: {
        Authorization: `Bearer ${config.ezBookkeepingApiToken}`,
        "X-Timezone-Name": config.timezone,
        "X-Timezone-Offset": "480"
      }
    });

    if (!response.ok) {
      return { error: `ezBookkeeping 回應 HTTP ${response.status}。` };
    }

    const payload = (await response.json().catch(() => ({}))) as { result?: unknown[] };
    return { transactions: Array.isArray(payload.result) ? (payload.result as TransactionRecord[]) : [] };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "ezBookkeeping 發生未知錯誤。" };
  }
}

function centsToAmount(value: number | undefined): number {
  return Number.isFinite(value) ? Math.round(Number(value)) / 100 : 0;
}

function addTotal(map: Map<string, number>, key: string, amount: number): void {
  map.set(key, (map.get(key) || 0) + amount);
}

function sumTotals(map: Map<string, number>): number {
  return [...map.values()].reduce((sum, amount) => sum + amount, 0);
}

function sumAbsoluteTotals(map: Map<string, number>): number {
  return [...map.values()].reduce((sum, amount) => sum + Math.abs(amount), 0);
}

function formatAmount(amount: number): string {
  const rounded = Math.round(amount * 100) / 100;
  if (Number.isInteger(rounded)) return rounded.toLocaleString("en-US");
  return rounded.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatSignedAmount(amount: number): string {
  return `${amount >= 0 ? "+" : "-"}${formatAmount(Math.abs(amount))}`;
}

function formatPercent(value: number): string {
  return `${Math.round(value)}%`;
}

function ratioBar(percent: number, width = 8): string {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
  return `<code>${"▓".repeat(filled)}${"░".repeat(width - filled)}</code>`;
}

function localDateKey(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value || "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function localMonthKey(date: Date, timezone: string): string {
  return localDateKey(date, timezone).slice(0, 7);
}

function localHeaderLabel(now: Date, timezone: string): string {
  const monthDay = new Intl.DateTimeFormat("en-US", { timeZone: timezone, month: "numeric", day: "numeric" }).format(now);
  const weekday = new Intl.DateTimeFormat("zh-TW", { timeZone: timezone, weekday: "short" }).format(now).replace(/^週/, "");
  return `${monthDay}（${weekday}）`;
}

function yesterdayKey(now: Date, timezone: string): string {
  return localDateKey(new Date(now.getTime() - 24 * 60 * 60 * 1000), timezone);
}

function transactionDate(transaction: TransactionRecord): Date | undefined {
  if (!Number.isFinite(transaction.time)) return undefined;
  return new Date(Number(transaction.time) * 1000);
}

function toPlain(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function inOverviewPeriod(transaction: TransactionRecord, period: SpendingOverviewPeriod, config: AppConfig, now: Date): boolean {
  const date = transactionDate(transaction);
  if (!date) return false;
  if (period === "today") return localDateKey(date, config.timezone) === localDateKey(now, config.timezone);
  if (period === "month") return localMonthKey(date, config.timezone) === localMonthKey(now, config.timezone);

  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  return date >= sevenDaysAgo && date <= now;
}

function overviewLabel(period: SpendingOverviewPeriod, config: AppConfig, now: Date): string {
  if (period === "today") return `今天（${localDateKey(now, config.timezone)}）`;
  if (period === "month") return `本月（${localMonthKey(now, config.timezone)}）`;
  return "近 7 天";
}

function readWatchlistSummary(path: string): WatchlistSummary {
  const title = "<b>觀察清單</b>";
  if (!existsSync(path)) {
    return {
      status: "partial",
      lines: [title, "⚠️ Watchlist config 不存在。"]
    };
  }

  try {
    const payload = JSON.parse(String(readFileSync(path, "utf8"))) as {
      symbols?: Array<{ ticker?: string; market?: string; displayName?: string }>;
    };
    const symbols = Array.isArray(payload.symbols) ? payload.symbols : [];
    if (symbols.length === 0) {
      return { status: "ok", lines: [title, "・尚未設定觀察清單。"] };
    }

    const lines = symbols.slice(0, 6).map((symbol) => {
      const market = escapeHtml(symbol.market || "UNKNOWN");
      const ticker = escapeHtml(symbol.ticker || "UNKNOWN");
      const displayName = symbol.displayName ? ` ${escapeHtml(symbol.displayName)}` : "";
      return `・${market}:${ticker}${displayName}`;
    });

    if (symbols.length > lines.length) {
      lines.push(`・另 ${symbols.length - lines.length} 檔`);
    }

    return { status: "ok", lines: [title, ...lines] };
  } catch (error) {
    return {
      status: "partial",
      lines: [
        title,
        `⚠️ Watchlist config 無法解析：${escapeHtml(error instanceof Error ? error.message : "未知錯誤")}`
      ]
    };
  }
}

function topCategoriesPlain(map: Map<string, number>, total: number, currency: string): string[] {
  const entries = [...map.entries()].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 5);
  return entries.map(([name, amount]) => {
    const share = total > 0 ? (Math.abs(amount) / total) * 100 : 0;
    return `${escapeHtml(name)} ${currency} ${formatAmount(amount)}（${formatPercent(share)}）`;
  });
}

function topTotalsWithShare(
  map: Map<string, number>,
  total: number,
  fallback: string,
  currency: string,
  signed = false
): string[] {
  const entries = [...map.entries()].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 6);
  if (entries.length === 0 || total <= 0) return [fallback];

  return entries.map(([name, amount]) => {
    const share = (Math.abs(amount) / total) * 100;
    const formattedAmount = signed ? formatSignedAmount(amount) : formatAmount(amount);
    return `${escapeHtml(name)}：${currency} ${formattedAmount}（${formatPercent(share)}）${ratioBar(share)}`;
  });
}

async function buildLlmComment(config: AppConfig, context: string, fetchImpl: typeof fetch): Promise<LlmCommentResult> {
  if (!config.llmSummaryEndpoint || !config.llmApiKey) {
    return { error: "LLM 摘要已啟用，但 endpoint 或 token 尚未設定。" };
  }

  try {
    const response = await fetchImpl(config.llmSummaryEndpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.llmApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        instruction: "Summarize this personal finance report as research commentary only. Do not mutate source records.",
        risk: "No broker execution. No guaranteed outcome.",
        context
      })
    });

    if (!response.ok) return { error: `LLM 摘要回應 HTTP ${response.status}。` };

    const payload = (await response.json().catch(() => ({}))) as { summary?: unknown };
    const summary = typeof payload.summary === "string" ? payload.summary.trim() : "";
    return summary ? { comment: summary } : { error: "LLM 摘要沒有回傳內容。" };
  } catch (error) {
    console.warn("llm summary failed", error instanceof Error ? error.message : String(error));
    return { error: error instanceof Error ? error.message : "LLM 摘要發生未知錯誤。" };
  }
}

function summarizeDaily(transactions: TransactionRecord[], config: AppConfig, store: StoreLike, now: Date): string {
  const currency = config.defaultCurrency || "TWD";
  const monthKey = localMonthKey(now, config.timezone);
  const yKey = yesterdayKey(now, config.timezone);

  let ySpending = 0;
  let yCount = 0;
  let mIncome = 0;
  let mExpense = 0;
  const mExpenseCategories = new Map<string, number>();
  const yLargeExpenses: string[] = [];

  for (const transaction of transactions) {
    const date = transactionDate(transaction);
    if (!date) continue;
    const amount = centsToAmount(transaction.sourceAmount);
    const category = transaction.category?.name || transaction.categoryId || "未分類";

    if (localMonthKey(date, config.timezone) === monthKey) {
      if (transaction.type === 3) {
        mExpense += amount;
        addTotal(mExpenseCategories, category, amount);
      } else if (transaction.type === 2) {
        mIncome += amount;
      }
    }

    if (localDateKey(date, config.timezone) === yKey && transaction.type === 3) {
      ySpending += amount;
      yCount += 1;
      if (amount >= LARGE_EXPENSE_THRESHOLD) {
        yLargeExpenses.push(`${category} ${formatAmount(amount)}${transaction.comment ? `（${transaction.comment}）` : ""}`);
      }
    }
  }

  const cashflow = mIncome - mExpense;
  const savingsRate = mIncome > 0 ? (cashflow / mIncome) * 100 : undefined;

  const lines: string[] = [
    `💰 昨日支出 ${currency} ${formatAmount(ySpending)}（${yCount} 筆）`,
    `📅 本月支出 ${currency} ${formatAmount(mExpense)}｜收入 ${currency} ${formatAmount(mIncome)}`,
    `　 淨現金流 ${currency} ${formatSignedAmount(cashflow)}${savingsRate !== undefined ? `（儲蓄率 ${formatPercent(savingsRate)}）` : ""}`
  ];

  const topCategories = topCategoriesPlain(mExpenseCategories, sumTotals(mExpenseCategories), currency);
  if (topCategories.length > 0) {
    lines.push("", "<b>本月支出 Top 5</b>");
    for (const line of topCategories) lines.push(`・${line}`);
  }

  if (yLargeExpenses.length > 0) {
    lines.push("");
    for (const expense of yLargeExpenses) lines.push(`⚠️ 昨日大額支出：${escapeHtml(expense)}`);
  }

  lines.push("", `📝 待審核 ${store.pendingReviewCount()} 筆`);

  return lines.join("\n");
}

function summarizeSpendingOverview(
  transactions: TransactionRecord[],
  config: AppConfig,
  store: StoreLike,
  period: SpendingOverviewPeriod,
  now: Date
): string {
  const periodTransactions = transactions.filter((transaction) => inOverviewPeriod(transaction, period, config, now));
  const currency = config.defaultCurrency || "TWD";
  let expenseTotal = 0;
  let incomeTotal = 0;
  let expenseCount = 0;
  let incomeCount = 0;
  let transferCount = 0;
  const expenseCategoryTotals = new Map<string, number>();
  const incomeCategoryTotals = new Map<string, number>();
  const accountTotals = new Map<string, number>();

  for (const transaction of periodTransactions) {
    const amount = centsToAmount(transaction.sourceAmount);
    const category = transaction.category?.name || transaction.categoryId || "未分類";
    const account = transaction.sourceAccount?.name || transaction.sourceAccountId || "未知帳戶";

    if (transaction.type === 3) {
      expenseTotal += amount;
      expenseCount += 1;
      addTotal(expenseCategoryTotals, category, amount);
      addTotal(accountTotals, account, -amount);
    } else if (transaction.type === 2) {
      incomeTotal += amount;
      incomeCount += 1;
      addTotal(incomeCategoryTotals, category, amount);
      addTotal(accountTotals, account, amount);
    } else if (transaction.type === 4) {
      const destination = transaction.destinationAccount?.name || transaction.destinationAccountId || "未知帳戶";
      transferCount += 1;
      addTotal(accountTotals, account, -amount);
      addTotal(accountTotals, destination, centsToAmount(transaction.destinationAmount ?? transaction.sourceAmount));
    }
  }

  const netCashflow = incomeTotal - expenseTotal;
  const accountMovementTotal = sumAbsoluteTotals(accountTotals);
  const spendingRatio = incomeTotal > 0 ? (expenseTotal / incomeTotal) * 100 : undefined;
  const savingsRate = incomeTotal > 0 ? (netCashflow / incomeTotal) * 100 : undefined;

  return [
    "📊 <b>FinOps 收支總覽</b>",
    `期間：${overviewLabel(period, config, now)}`,
    `交易：${periodTransactions.length} 筆（收入 ${incomeCount}、支出 ${expenseCount}、轉帳 ${transferCount}）`,
    `收入：${currency} ${formatAmount(incomeTotal)}`,
    `支出：${currency} ${formatAmount(expenseTotal)}`,
    `淨現金流：${currency} ${formatSignedAmount(netCashflow)}${savingsRate !== undefined ? `（儲蓄率 ${formatPercent(savingsRate)}）` : ""}`,
    ...(spendingRatio !== undefined
      ? [`支出佔收入：${formatPercent(spendingRatio)}`]
      : ["支出佔收入：本期無收入，無法計算。"]),
    "",
    "<b>支出分類</b>",
    ...topTotalsWithShare(expenseCategoryTotals, sumTotals(expenseCategoryTotals), "本期無支出分類。", currency).map((line) => `・${line}`),
    "",
    "<b>收入分類</b>",
    ...topTotalsWithShare(incomeCategoryTotals, sumTotals(incomeCategoryTotals), "本期無收入分類。", currency).map((line) => `・${line}`),
    "",
    "<b>帳戶異動</b>",
    ...topTotalsWithShare(accountTotals, accountMovementTotal, "本期無帳戶異動。", currency, true).map((line) => `・${line}`),
    "",
    `📝 待審核 ${store.pendingReviewCount()} 筆`
  ].join("\n");
}

function summarizeEndOfDay(transactions: TransactionRecord[], config: AppConfig, store: StoreLike, now: Date): { status: "ok" | "partial"; body: string } {
  const today = localDateKey(now, config.timezone);
  const currency = config.defaultCurrency || "TWD";
  const expenses = transactions.filter((transaction) => {
    const date = transactionDate(transaction);
    return transaction.type === 3 && date && localDateKey(date, config.timezone) === today;
  });

  if (expenses.length === 0) {
    return {
      status: "partial",
      body: [`今日（${today}）尚無支出紀錄。`, "", `📝 待審核 ${store.pendingReviewCount()} 筆`].join("\n")
    };
  }

  let total = 0;
  const categoryTotals = new Map<string, number>();
  const accountTotals = new Map<string, number>();
  for (const transaction of expenses) {
    const amount = centsToAmount(transaction.sourceAmount);
    total += amount;
    addTotal(categoryTotals, transaction.category?.name || transaction.categoryId || "未分類", amount);
    addTotal(accountTotals, transaction.sourceAccount?.name || transaction.sourceAccountId || "未知帳戶", amount);
  }

  const categoryLines = [...categoryTotals.entries()].sort((a, b) => b[1] - a[1]).map(([name, amount]) => `・${escapeHtml(name)} ${formatAmount(amount)}`);
  const accountLines = [...accountTotals.entries()].sort((a, b) => b[1] - a[1]).map(([name, amount]) => `・${escapeHtml(name)} ${formatAmount(amount)}`);

  return {
    status: "ok",
    body: [
      `💰 今日支出 ${currency} ${formatAmount(total)}（${expenses.length} 筆）`,
      "",
      "<b>分類</b>",
      ...categoryLines,
      "",
      "<b>帳戶</b>",
      ...accountLines,
      "",
      `📝 待審核 ${store.pendingReviewCount()} 筆`
    ].join("\n")
  };
}

function truncateForTelegram(html: string, limit = 3500): string {
  if (html.length <= limit) return html;
  const clipped = html.slice(0, limit);
  const lastBreak = clipped.lastIndexOf("\n");
  const safe = lastBreak > limit * 0.6 ? clipped.slice(0, lastBreak) : clipped;
  return `${safe}\n…（已截斷，完整內容見報表檔案）`;
}

export async function generateSpendingOverview(
  config: AppConfig,
  store: StoreLike,
  period: SpendingOverviewPeriod,
  fetchImpl: typeof fetch = fetch,
  now = new Date()
): Promise<{ status: "ok" | "partial"; text: string }> {
  const result = await fetchEzBookkeepingTransactions(config, fetchImpl);
  if (result.error) {
    return {
      status: "partial",
      text: [
        "📊 <b>FinOps 收支總覽</b>",
        `期間：${overviewLabel(period, config, now)}`,
        "",
        `⚠️ 記帳資料暫時無法取得：${escapeHtml(result.error)}`,
        "",
        `📝 待審核 ${store.pendingReviewCount()} 筆`
      ].join("\n")
    };
  }

  return {
    status: "ok",
    text: summarizeSpendingOverview(result.transactions || [], config, store, period, now)
  };
}

export async function generateDailyReport(
  config: AppConfig,
  store: StoreLike,
  fetchImpl: typeof fetch = fetch,
  now = new Date()
): Promise<{ status: "ok" | "partial"; text: string; artifactPath: string }> {
  mkdirSync(config.reportDir, { recursive: true });

  const header = `📊 <b>FinOps 日報</b> ${localHeaderLabel(now, config.timezone)}`;
  const result = await fetchEzBookkeepingTransactions(config, fetchImpl);

  let status: "ok" | "partial";
  let html: string;

  const parts = [header, ""];

  if (result.error) {
    status = "partial";
    parts.push(`⚠️ 記帳資料暫時無法取得：${escapeHtml(result.error)}`, "", `📝 待審核 ${store.pendingReviewCount()} 筆`);
  } else {
    status = "ok";
    const body = summarizeDaily(result.transactions || [], config, store, now);
    parts.push(body);
  }

  const watchlist = readWatchlistSummary(config.watchlistPath);
  if (watchlist.status !== "ok") status = "partial";
  parts.push("", ...watchlist.lines);

  if (config.llmEnabled) {
    const llm = await buildLlmComment(config, toPlain(parts.join("\n")), fetchImpl);
    if (llm.comment) {
      parts.push("", `🧠 ${escapeHtml(llm.comment)}`);
    } else if (llm.error) {
      status = "partial";
      parts.push("", `⚠️ LLM 摘要暫時無法取得：${escapeHtml(llm.error)}`);
    }
  }

  html = parts.join("\n");

  const plain = toPlain(html);
  const artifactPath = join(config.reportDir, `daily-${localDateKey(now, config.timezone)}.md`);
  writeFileSync(artifactPath, plain, "utf8");

  store.recordReport("daily", status, plain.split("\n").slice(0, 3).join(" | "), artifactPath);

  if (config.telegramReportChatId) {
    await sendTelegramMessage(config, config.telegramReportChatId, truncateForTelegram(html), fetchImpl);
  }

  return { status, text: html, artifactPath };
}

export async function generateEndOfDaySpendingReport(
  config: AppConfig,
  store: StoreLike,
  fetchImpl: typeof fetch = fetch,
  now = new Date()
): Promise<{ status: "ok" | "partial"; text: string; artifactPath: string }> {
  mkdirSync(config.reportDir, { recursive: true });

  const header = `🧾 <b>FinOps 今日支出結算</b> ${localHeaderLabel(now, config.timezone)}`;
  const result = await fetchEzBookkeepingTransactions(config, fetchImpl);

  let status: "ok" | "partial";
  let html: string;

  if (result.error) {
    status = "partial";
    html = [header, "", `⚠️ 記帳資料暫時無法取得：${escapeHtml(result.error)}`, "", `📝 待審核 ${store.pendingReviewCount()} 筆`].join("\n");
  } else {
    const summary = summarizeEndOfDay(result.transactions || [], config, store, now);
    status = summary.status;
    html = [header, "", summary.body].join("\n");
  }

  const plain = toPlain(html);
  const artifactPath = join(config.reportDir, `end-of-day-spending-${localDateKey(now, config.timezone)}.md`);
  writeFileSync(artifactPath, plain, "utf8");

  store.recordReport("end-of-day-spending", status, plain.split("\n").slice(0, 3).join(" | "), artifactPath);

  if (config.telegramReportChatId) {
    await sendTelegramMessage(config, config.telegramReportChatId, truncateForTelegram(html), fetchImpl);
  }

  return { status, text: html, artifactPath };
}
