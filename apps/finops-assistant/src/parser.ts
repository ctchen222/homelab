import {
  BookkeepingCategoryType,
  ParsedMessage,
  ParsedTransaction,
  SpendingOverviewPeriod,
  TransactionType,
} from "./types";

const TYPE_ALIASES: Record<string, TransactionType> = {
  expense: "expense",
  spend: "expense",
  paid: "expense",
  income: "income",
  salary: "income",
  transfer: "transfer",
  move: "transfer"
};

function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

interface ParseMessageOptions {
  defaultCurrency?: string;
  defaultExpenseAccount?: string;
  defaultIncomeAccount?: string;
  knownAccounts?: string[];
}

function normalizeCommand(token: string | undefined): string {
  return (token || "").replace(/^\/+/, "").split("@")[0].toLowerCase();
}

function parseAmount(token: string | undefined): number | undefined {
  if (!token) return undefined;
  const normalized = token.replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return undefined;
  const amount = Number.parseFloat(normalized);
  return Number.isFinite(amount) && amount > 0 ? amount : undefined;
}

function findToken(tokens: string[], name: string): string | undefined {
  const prefix = `${name}:`;
  const inline = tokens.find((token) => token.toLowerCase().startsWith(prefix));
  if (inline) return inline.slice(prefix.length);

  const index = tokens.findIndex((token) => token.toLowerCase() === name);
  if (index >= 0) return tokens[index + 1];
  return undefined;
}

function textAfterKnownFields(tokens: string[], positionalFieldIndexes = new Set<number>(), startIndex = 3): string | undefined {
  const skip = new Set(["account", "category", "from", "to", "note"]);
  const noteIndex = tokens.findIndex((token) => token.toLowerCase() === "note" || token.toLowerCase().startsWith("note:"));
  if (noteIndex >= 0) {
    const first = tokens[noteIndex];
    if (first.includes(":")) {
      return [first.slice(first.indexOf(":") + 1), ...tokens.slice(noteIndex + 1)].join(" ").trim() || undefined;
    }
    return tokens.slice(noteIndex + 1).join(" ").trim() || undefined;
  }

  const leftovers: string[] = [];
  for (let index = startIndex; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (positionalFieldIndexes.has(index) || token.includes(":")) continue;
    if (skip.has(token.toLowerCase())) {
      index += 1;
      continue;
    }
    leftovers.push(token);
  }
  return leftovers.join(" ").trim() || undefined;
}

function parseOverviewPeriod(token: string | undefined): SpendingOverviewPeriod | undefined {
  const period = (token || "today").toLowerCase();
  if (period === "today" || period === "day") return "today";
  if (period === "month" || period === "monthly" || period === "thismonth") return "month";
  if (period === "7d" || period === "week" || period === "weekly") return "7d";
  return undefined;
}

function parseCategoryType(token: string | undefined): BookkeepingCategoryType | undefined {
  const type = (token || "").toLowerCase();
  if (type === "income" || type === "incomes") return "income";
  if (type === "expense" || type === "expenses" || type === "spending") return "expense";
  if (type === "transfer" || type === "transfers") return "transfer";
  return undefined;
}

function isCurrency(token: string | undefined): boolean {
  return Boolean(token && /^[A-Za-z]{3}$/.test(token));
}

function knownAccountSet(options: ParseMessageOptions): Set<string> {
  return new Set((options.knownAccounts || []).map((account) => account.toLowerCase()));
}

function collectUntil(tokens: string[], startIndex: number, stops: Set<string>): { value?: string; nextIndex: number } {
  const parts: string[] = [];
  let index = startIndex;
  while (index < tokens.length) {
    const token = tokens[index];
    if (stops.has(token.toLowerCase())) break;
    parts.push(token);
    index += 1;
  }

  return { value: parts.join(" ").trim() || undefined, nextIndex: index };
}

function parseCategoryAdd(tokens: string[], normalizedText: string): ParsedMessage {
  const categoryType = parseCategoryType(tokens[2]);
  const missing: string[] = [];
  if (!categoryType) missing.push("categoryType");

  const stops = new Set(["under", "parent", "alias"]);
  const name = collectUntil(tokens, 3, stops);
  let parentName: string | undefined;
  let alias: string | undefined;
  let index = name.nextIndex;

  while (index < tokens.length) {
    const token = tokens[index].toLowerCase();
    if (token === "under" || token === "parent") {
      const parent = collectUntil(tokens, index + 1, new Set(["alias"]));
      parentName = parent.value;
      index = parent.nextIndex;
    } else if (token === "alias") {
      const aliasValue = collectUntil(tokens, index + 1, new Set(["under", "parent"]));
      alias = aliasValue.value;
      index = aliasValue.nextIndex;
    } else {
      index += 1;
    }
  }

  if (!name.value) missing.push("categoryName");

  return missing.length > 0 || !categoryType || !name.value
    ? { kind: "ambiguous", missing, normalizedText }
    : { kind: "category_add", categoryType, name: name.value, parentName, alias };
}

function parseCategoryConfirm(tokens: string[], normalizedText: string): ParsedMessage {
  const updateId = Number.parseInt(tokens[2] || "", 10);
  const missing: string[] = [];
  if (!Number.isSafeInteger(updateId)) missing.push("updateId");

  let parentName: string | undefined;
  let alias: string | undefined;
  let index = 3;
  while (index < tokens.length) {
    const token = tokens[index].toLowerCase();
    if (token === "under" || token === "parent") {
      const parent = collectUntil(tokens, index + 1, new Set(["alias"]));
      parentName = parent.value;
      index = parent.nextIndex;
    } else if (token === "alias") {
      const aliasValue = collectUntil(tokens, index + 1, new Set(["under", "parent"]));
      alias = aliasValue.value;
      index = aliasValue.nextIndex;
    } else {
      index += 1;
    }
  }

  return missing.length > 0
    ? { kind: "ambiguous", missing, normalizedText }
    : { kind: "category_confirm", updateId, parentName, alias };
}

export function parseMessage(input: string, now = new Date(), options: ParseMessageOptions = {}): ParsedMessage {
  const normalizedText = normalizeText(input);
  if (!normalizedText) {
    return { kind: "ambiguous", missing: ["text"], normalizedText };
  }

  const tokens = normalizedText.split(" ");
  const command = normalizeCommand(tokens[0]);

  if (command === "start" || command === "help") {
    return { kind: "help" };
  }

  if (command === "status") {
    return { kind: "status" };
  }

  if (command === "overview" || command === "summary") {
    const period = parseOverviewPeriod(tokens[1]);
    return period
      ? { kind: "overview", period }
      : { kind: "ambiguous", missing: ["overviewPeriod"], normalizedText };
  }

  if (command === "categories" || command === "categorylist") {
    const categoryType = parseCategoryType(tokens[1]);
    return tokens[1] && !categoryType
      ? { kind: "ambiguous", missing: ["categoryType"], normalizedText }
      : { kind: "categories", categoryType };
  }

  if (command === "accounts" || command === "accountlist") {
    return { kind: "accounts" };
  }

  if (command === "category" || command === "cat") {
    const action = (tokens[1] || "list").toLowerCase();
    if (action === "list" || action === "ls") {
      const categoryType = parseCategoryType(tokens[2]);
      return tokens[2] && !categoryType
        ? { kind: "ambiguous", missing: ["categoryType"], normalizedText }
        : { kind: "categories", categoryType };
    }
    if (action === "add" || action === "new") {
      return parseCategoryAdd(tokens, normalizedText);
    }
    if (action === "confirm") {
      return parseCategoryConfirm(tokens, normalizedText);
    }
  }

  if (command === "correct" || command === "correction") {
    const reference = tokens[1];
    const note = tokens.slice(2).join(" ").trim();
    const missing = [];
    if (!reference) missing.push("reference");
    if (!note) missing.push("note");
    return missing.length > 0
      ? { kind: "ambiguous", missing, normalizedText }
      : { kind: "correction", reference, note };
  }

  const type = TYPE_ALIASES[command];
  const amount = parseAmount(tokens[1]);
  const hasExplicitCurrency = isCurrency(tokens[2]);
  const currency = hasExplicitCurrency ? tokens[2]?.toUpperCase() : options.defaultCurrency?.toUpperCase();
  const fieldStart = hasExplicitCurrency ? 3 : 2;
  const missing: string[] = [];

  if (!type) missing.push("type");
  if (!amount) missing.push("amount");
  if (!currency || !/^[A-Z]{3}$/.test(currency)) missing.push("currency");

  if (missing.length > 0 || !type || !amount || !currency) {
    return { kind: "ambiguous", missing, normalizedText };
  }

  const transaction: ParsedTransaction = {
    type,
    amount,
    currency,
    currencyDefaulted: !hasExplicitCurrency,
    occurredAt: now.toISOString()
  };

  if (type === "transfer") {
    transaction.fromAccount = findToken(tokens, "from") || tokens[fieldStart];
    transaction.toAccount = findToken(tokens, "to") || tokens[fieldStart + 1];
    transaction.note = textAfterKnownFields(tokens, new Set([fieldStart, fieldStart + 1]), fieldStart);
    if (!transaction.fromAccount) missing.push("fromAccount");
    if (!transaction.toAccount) missing.push("toAccount");
  } else {
    const defaultAccount = type === "income" ? options.defaultIncomeAccount : options.defaultExpenseAccount;
    const accountAliases = knownAccountSet(options);
    const positionalAccount = tokens[fieldStart + 1];
    const explicitAccount = findToken(tokens, "account");
    const accountLooksExplicit =
      explicitAccount ||
      (positionalAccount && (!defaultAccount || accountAliases.has(positionalAccount.toLowerCase())));

    transaction.category = findToken(tokens, "category") || tokens[fieldStart];
    transaction.account = explicitAccount || (accountLooksExplicit ? positionalAccount : defaultAccount);
    transaction.accountDefaulted = Boolean(transaction.account && !explicitAccount && !accountLooksExplicit);
    transaction.note = textAfterKnownFields(
      tokens,
      new Set(accountLooksExplicit ? [fieldStart, fieldStart + 1] : [fieldStart]),
      fieldStart
    );
    if (!transaction.category) missing.push("category");
    if (!transaction.account) missing.push("account");
  }

  if (missing.length > 0) {
    return { kind: "ambiguous", missing, normalizedText };
  }

  return { kind: "transaction", transaction };
}
