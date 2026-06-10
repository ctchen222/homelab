import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AppConfig, SpendingOverviewPeriod } from "./types";
import { sendTelegramMessage } from "./telegram";

interface StoreLike {
  pendingReviewCount(): number;
  recordReport(reportType: string, status: string, summary: string, artifactPath?: string): void;
}

interface ReportSection {
  title: string;
  status: "ok" | "missing" | "error";
  lines: string[];
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
  errorSection?: ReportSection;
}

function readWatchlist(path: string): ReportSection {
  if (!existsSync(path)) {
    return { title: "Watchlist", status: "missing", lines: ["Watchlist config not found."] };
  }

  try {
    const payload = JSON.parse(String(readFileSync(path, "utf8"))) as { symbols?: Array<{ ticker: string; market: string; displayName: string }> };
    const symbols = payload.symbols || [];
    return {
      title: "Watchlist",
      status: "ok",
      lines: symbols.map((symbol) => `${symbol.market}:${symbol.ticker} ${symbol.displayName}`)
    };
  } catch (error) {
    return {
      title: "Watchlist",
      status: "error",
      lines: [error instanceof Error ? error.message : "Watchlist config could not be parsed."]
    };
  }
}

async function fetchEzBookkeepingTransactions(config: AppConfig, fetchImpl: typeof fetch): Promise<TransactionFetchResult> {
  if (!config.ezBookkeepingBaseUrl || !config.ezBookkeepingApiToken) {
    return { errorSection: { title: "Bookkeeping", status: "missing", lines: ["ezBookkeeping API token not configured."] } };
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
      return { errorSection: { title: "Bookkeeping", status: "error", lines: [`ezBookkeeping returned HTTP ${response.status}.`] } };
    }

    const payload = (await response.json().catch(() => ({}))) as { result?: unknown[] };
    return { transactions: Array.isArray(payload.result) ? (payload.result as TransactionRecord[]) : [] };
  } catch (error) {
    return {
      errorSection: {
        title: "Bookkeeping",
        status: "error",
        lines: [error instanceof Error ? error.message : "Unknown ezBookkeeping error."]
      }
    };
  }
}

async function fetchEzBookkeepingSummary(config: AppConfig, fetchImpl: typeof fetch): Promise<ReportSection[]> {
  const result = await fetchEzBookkeepingTransactions(config, fetchImpl);
  return result.errorSection ? [result.errorSection] : summarizeTransactions(result.transactions || []);
}

function summarizeTransactions(transactions: TransactionRecord[]): ReportSection[] {
  if (transactions.length === 0) {
    return [
      { title: "Spending", status: "missing", lines: ["No recent spending data returned."] },
      { title: "Income", status: "missing", lines: ["No recent income data returned."] },
      { title: "Cashflow", status: "missing", lines: ["No recent transaction data returned."] },
      { title: "Account Summary", status: "missing", lines: ["No account movement data returned."] },
      { title: "Anomalies", status: "ok", lines: ["No anomalies detected because no recent transactions were returned."] }
    ];
  }

  let spending = 0;
  let income = 0;
  const categoryTotals = new Map<string, number>();
  const accountTotals = new Map<string, number>();
  const anomalies: string[] = [];

  for (const transaction of transactions) {
    const amount = centsToAmount(transaction.sourceAmount);
    const category = transaction.category?.name || transaction.categoryId || "Uncategorized";
    const account = transaction.sourceAccount?.name || transaction.sourceAccountId || "Unknown account";

    if (transaction.type === 3) {
      spending += amount;
      addTotal(categoryTotals, category, amount);
      addTotal(accountTotals, account, -amount);
      if (amount >= 2000) {
        anomalies.push(`Large expense ${formatAmount(amount)} in ${category}${transaction.comment ? `: ${transaction.comment}` : ""}`);
      }
    } else if (transaction.type === 2) {
      income += amount;
      addTotal(accountTotals, account, amount);
    } else if (transaction.type === 4) {
      const destination = transaction.destinationAccount?.name || transaction.destinationAccountId || "Unknown destination";
      addTotal(accountTotals, account, -amount);
      addTotal(accountTotals, destination, centsToAmount(transaction.destinationAmount ?? transaction.sourceAmount));
    }
  }

  const cashflow = income - spending;

  return [
    {
      title: "Spending",
      status: spending > 0 ? "ok" : "missing",
      lines: [`Total spending: ${formatAmount(spending)}`, ...topTotals(categoryTotals, "No expense categories returned.")]
    },
    {
      title: "Income",
      status: income > 0 ? "ok" : "missing",
      lines: [`Total income: ${formatAmount(income)}`]
    },
    {
      title: "Cashflow",
      status: "ok",
      lines: [`Net cashflow: ${formatAmount(cashflow)}`]
    },
    {
      title: "Account Summary",
      status: accountTotals.size > 0 ? "ok" : "missing",
      lines: topTotals(accountTotals, "No account movement returned.")
    },
    {
      title: "Anomalies",
      status: "ok",
      lines: anomalies.length > 0 ? anomalies : ["No large expenses detected."]
    }
  ];
}

function centsToAmount(value: number | undefined): number {
  return Number.isFinite(value) ? Math.round(Number(value)) / 100 : 0;
}

function addTotal(map: Map<string, number>, key: string, amount: number): void {
  map.set(key, (map.get(key) || 0) + amount);
}

function topTotals(map: Map<string, number>, fallback: string): string[] {
  const entries = [...map.entries()].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 5);
  if (entries.length === 0) return [fallback];
  return entries.map(([name, amount]) => `${name}: ${formatAmount(amount)}`);
}

function sumTotals(map: Map<string, number>): number {
  return [...map.values()].reduce((sum, amount) => sum + amount, 0);
}

function sumAbsoluteTotals(map: Map<string, number>): number {
  return [...map.values()].reduce((sum, amount) => sum + Math.abs(amount), 0);
}

function formatAmount(amount: number): string {
  return amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatSignedAmount(amount: number): string {
  return `${amount >= 0 ? "+" : "-"}${formatAmount(Math.abs(amount))}`;
}

function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

function ratioBar(percent: number, width = 18): string {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
  return `[${"#".repeat(filled)}${".".repeat(width - filled)}]`;
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
    return `${name}: ${currency} ${formattedAmount} (${formatPercent(share)}) ${ratioBar(share)}`;
  });
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

function transactionDate(transaction: TransactionRecord): Date | undefined {
  if (!Number.isFinite(transaction.time)) return undefined;
  return new Date(Number(transaction.time) * 1000);
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
  if (period === "today") return `Today (${localDateKey(now, config.timezone)})`;
  if (period === "month") return `This month (${localMonthKey(now, config.timezone)})`;
  return "Last 7 days";
}

function summarizeSpendingOverview(
  transactions: TransactionRecord[],
  config: AppConfig,
  store: StoreLike,
  period: SpendingOverviewPeriod,
  now = new Date()
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
    const category = transaction.category?.name || transaction.categoryId || "Uncategorized";
    const account = transaction.sourceAccount?.name || transaction.sourceAccountId || "Unknown account";

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
      const destination = transaction.destinationAccount?.name || transaction.destinationAccountId || "Unknown destination";
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
    "FinOps Period Overview",
    `Period: ${overviewLabel(period, config, now)}`,
    `Transactions: ${periodTransactions.length} (income ${incomeCount}, expense ${expenseCount}, transfer ${transferCount})`,
    `Income: ${currency} ${formatAmount(incomeTotal)}`,
    `Expenses: ${currency} ${formatAmount(expenseTotal)}`,
    `Net cashflow: ${currency} ${formatSignedAmount(netCashflow)}`,
    ...(spendingRatio !== undefined
      ? [`Spending / income: ${formatPercent(spendingRatio)}`, `Savings rate: ${formatPercent(savingsRate || 0)}`]
      : ["Spending / income: n/a because no income was recorded in this period."]),
    "",
    "Expense categories:",
    ...topTotalsWithShare(
      expenseCategoryTotals,
      sumTotals(expenseCategoryTotals),
      "No expense categories returned.",
      currency
    ).map((line) => `- ${line}`),
    "",
    "Income categories:",
    ...topTotalsWithShare(
      incomeCategoryTotals,
      sumTotals(incomeCategoryTotals),
      "No income categories returned.",
      currency
    ).map((line) => `- ${line}`),
    "",
    "Account movement:",
    ...topTotalsWithShare(
      accountTotals,
      accountMovementTotal,
      "No account movement returned.",
      currency,
      true
    ).map((line) => `- ${line}`),
    "",
    `Pending reviews: ${store.pendingReviewCount()}`
  ].join("\n");
}

function summarizeEndOfDaySpending(transactions: TransactionRecord[], config: AppConfig, now = new Date()): ReportSection[] {
  const today = localDateKey(now, config.timezone);
  const expenses = transactions.filter((transaction) => {
    const date = transactionDate(transaction);
    return transaction.type === 3 && date && localDateKey(date, config.timezone) === today;
  });

  if (expenses.length === 0) {
    return [
      {
        title: "Today",
        status: "missing",
        lines: [`No spending recorded for ${today}.`]
      }
    ];
  }

  let total = 0;
  const categoryTotals = new Map<string, number>();
  const accountTotals = new Map<string, number>();

  for (const transaction of expenses) {
    const amount = centsToAmount(transaction.sourceAmount);
    total += amount;
    addTotal(categoryTotals, transaction.category?.name || transaction.categoryId || "Uncategorized", amount);
    addTotal(accountTotals, transaction.sourceAccount?.name || transaction.sourceAccountId || "Unknown account", amount);
  }

  return [
    {
      title: "Today",
      status: "ok",
      lines: [`Date: ${today}`, `Total spending: ${formatAmount(total)}`, `Transactions: ${expenses.length}`]
    },
    {
      title: "Categories",
      status: "ok",
      lines: topTotals(categoryTotals, "No expense categories returned.")
    },
    {
      title: "Accounts",
      status: "ok",
      lines: topTotals(accountTotals, "No account movement returned.")
    }
  ];
}

export async function generateSpendingOverview(
  config: AppConfig,
  store: StoreLike,
  period: SpendingOverviewPeriod,
  fetchImpl: typeof fetch = fetch,
  now = new Date()
): Promise<{ status: "ok" | "partial"; text: string }> {
  const result = await fetchEzBookkeepingTransactions(config, fetchImpl);
  if (result.errorSection) {
    return {
      status: "partial",
      text: [
        "FinOps Period Overview",
        `Period: ${overviewLabel(period, config, now)}`,
        "",
        "Bookkeeping data unavailable:",
        ...result.errorSection.lines.map((line) => `- ${line}`),
        "",
        `Pending reviews: ${store.pendingReviewCount()}`
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
  fetchImpl: typeof fetch = fetch
): Promise<{ status: "ok" | "partial"; text: string; artifactPath: string }> {
  mkdirSync(config.reportDir, { recursive: true });

  const bookkeepingSections = await fetchEzBookkeepingSummary(config, fetchImpl);
  const sections: ReportSection[] = [
    ...bookkeepingSections,
    {
      title: "Pending Reviews",
      status: "ok",
      lines: [`Pending review items: ${store.pendingReviewCount()}`]
    },
    readWatchlist(config.watchlistPath),
    {
      title: "Risk",
      status: "ok",
      lines: ["Research commentary only. No broker execution."]
    }
  ];

  sections.push(await buildLlmSection(config, sections, fetchImpl));

  const partial = sections.some((section) => section.status !== "ok");
  const text = renderReport(sections);
  const artifactPath = join(config.reportDir, `daily-${new Date().toISOString().slice(0, 10)}.md`);
  writeFileSync(artifactPath, text, "utf8");

  store.recordReport("daily", partial ? "partial" : "ok", sections.map((section) => `${section.title}:${section.status}`).join(", "), artifactPath);

  if (config.telegramReportChatId) {
    await sendTelegramMessage(config, config.telegramReportChatId, text.slice(0, 3500), fetchImpl);
  }

  return { status: partial ? "partial" : "ok", text, artifactPath };
}

export async function generateEndOfDaySpendingReport(
  config: AppConfig,
  store: StoreLike,
  fetchImpl: typeof fetch = fetch,
  now = new Date()
): Promise<{ status: "ok" | "partial"; text: string; artifactPath: string }> {
  mkdirSync(config.reportDir, { recursive: true });

  const result = await fetchEzBookkeepingTransactions(config, fetchImpl);
  const sections: ReportSection[] = result.errorSection
    ? [result.errorSection]
    : summarizeEndOfDaySpending(result.transactions || [], config, now);

  sections.push({
    title: "Pending Reviews",
    status: "ok",
    lines: [`Pending review items: ${store.pendingReviewCount()}`]
  });

  const partial = sections.some((section) => section.status !== "ok");
  const text = renderReport(sections, "FinOps End-of-Day Spending Summary");
  const artifactPath = join(config.reportDir, `end-of-day-spending-${localDateKey(now, config.timezone)}.md`);
  writeFileSync(artifactPath, text, "utf8");

  store.recordReport(
    "end-of-day-spending",
    partial ? "partial" : "ok",
    sections.map((section) => `${section.title}:${section.status}`).join(", "),
    artifactPath
  );

  if (config.telegramReportChatId) {
    await sendTelegramMessage(config, config.telegramReportChatId, text.slice(0, 3500), fetchImpl);
  }

  return { status: partial ? "partial" : "ok", text, artifactPath };
}

async function buildLlmSection(config: AppConfig, sections: ReportSection[], fetchImpl: typeof fetch): Promise<ReportSection> {
  if (!config.llmEnabled) {
    return {
      title: "LLM",
      status: "ok",
      lines: ["LLM summarization disabled. Raw report sections still generated."]
    };
  }

  if (!config.llmSummaryEndpoint || !config.llmApiKey) {
    return {
      title: "LLM",
      status: "missing",
      lines: ["LLM summarization enabled but endpoint or token is not configured."]
    };
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
        sections
      })
    });

    if (!response.ok) {
      return { title: "LLM", status: "error", lines: [`LLM summary endpoint returned HTTP ${response.status}.`] };
    }

    const payload = (await response.json().catch(() => ({}))) as { summary?: unknown };
    return {
      title: "LLM",
      status: typeof payload.summary === "string" && payload.summary.trim() ? "ok" : "missing",
      lines: [typeof payload.summary === "string" && payload.summary.trim() ? payload.summary.trim() : "LLM summary returned no text."]
    };
  } catch (error) {
    return {
      title: "LLM",
      status: "error",
      lines: [error instanceof Error ? error.message : "Unknown LLM summary error."]
    };
  }
}

function renderReport(sections: ReportSection[], title = "FinOps Daily Report"): string {
  const lines = [title, `Generated: ${new Date().toISOString()}`, ""];

  for (const section of sections) {
    lines.push(`## ${section.title} (${section.status})`);
    for (const line of section.lines) {
      lines.push(`- ${line}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
