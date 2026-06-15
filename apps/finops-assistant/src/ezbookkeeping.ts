import {
  AppConfig,
  BookkeepingCategoryType,
  EzBookkeepingResult,
  ParsedTransaction,
} from "./types";

export interface EzBookkeepingCategory {
  id: string;
  name: string;
  parentId: string;
  type: number;
  icon?: string;
  color?: string;
  comment?: string;
  hidden?: boolean;
  subCategories?: EzBookkeepingCategory[];
}

export interface EzBookkeepingAccount {
  id: string;
  name: string;
  parentId?: string;
  category?: number;
  type?: number;
  currency?: string;
  hidden?: boolean;
}

const CATEGORY_TYPE_IDS: Record<BookkeepingCategoryType, number> = {
  income: 1,
  expense: 2,
  transfer: 3,
};

const DEFAULT_PARENT_CATEGORY: Record<BookkeepingCategoryType, string> = {
  income: "Miscellaneous",
  expense: "Miscellaneous",
  transfer: "General Transfer",
};

function cents(amount: number): number {
  return Math.round(amount * 100);
}

function lookup(map: Record<string, string>, key: string | undefined): string | undefined {
  if (!key) return undefined;
  return map[key.toLowerCase()] || map[key];
}

export function lookupAlias(map: Record<string, string>, key: string | undefined): string | undefined {
  return lookup(map, key);
}

function transactionType(type: ParsedTransaction["type"]): number {
  if (type === "income") return 2;
  if (type === "expense") return 3;
  return 4;
}

function requireApiConfig(config: AppConfig): { baseUrl: string; token: string } {
  if (!config.ezBookkeepingBaseUrl || !config.ezBookkeepingApiToken) {
    throw new Error("ezBookkeeping API not configured");
  }

  return {
    baseUrl: config.ezBookkeepingBaseUrl.replace(/\/$/, ""),
    token: config.ezBookkeepingApiToken,
  };
}

function apiHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

export function categoryTypeId(categoryType: BookkeepingCategoryType): number {
  return CATEGORY_TYPE_IDS[categoryType];
}

export function transactionCategoryType(type: ParsedTransaction["type"]): BookkeepingCategoryType {
  if (type === "income") return "income";
  if (type === "transfer") return "transfer";
  return "expense";
}

export function defaultParentCategory(categoryType: BookkeepingCategoryType): string {
  return DEFAULT_PARENT_CATEGORY[categoryType];
}

export function flattenCategories(categories: EzBookkeepingCategory[]): EzBookkeepingCategory[] {
  const result: EzBookkeepingCategory[] = [];
  for (const category of categories) {
    result.push(category);
    result.push(...flattenCategories(category.subCategories || []));
  }
  return result;
}

function findCategoryByName(categories: EzBookkeepingCategory[], name: string): EzBookkeepingCategory | undefined {
  const normalized = name.trim().toLowerCase();
  return flattenCategories(categories).find((category) => category.name.toLowerCase() === normalized);
}

function titleCaseName(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function aliasFromCategoryName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

export async function listTransactionCategories(
  config: AppConfig,
  categoryType: BookkeepingCategoryType | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<EzBookkeepingCategory[]> {
  const { baseUrl, token } = requireApiConfig(config);
  const types = categoryType ? [categoryType] : (["income", "expense", "transfer"] as const);
  const categories: EzBookkeepingCategory[] = [];

  for (const type of types) {
    const response = await fetchImpl(
      `${baseUrl}/api/v1/transaction/categories/list.json?type=${CATEGORY_TYPE_IDS[type]}`,
      { headers: apiHeaders(token) },
    );

    if (!response.ok) {
      throw new Error(`ezBookkeeping category list failed with ${response.status}`);
    }

    const payload = (await response.json()) as {
      result?: Record<string, EzBookkeepingCategory[]>;
      success?: boolean;
    };
    if (payload.success === false) {
      throw new Error("ezBookkeeping category list failed");
    }

    categories.push(...(payload.result?.[String(CATEGORY_TYPE_IDS[type])] || []));
  }

  return categories;
}

export async function listAccounts(
  config: AppConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<EzBookkeepingAccount[]> {
  const { baseUrl, token } = requireApiConfig(config);
  const response = await fetchImpl(`${baseUrl}/api/v1/accounts/list.json`, {
    headers: apiHeaders(token),
  });

  if (!response.ok) {
    throw new Error(`ezBookkeeping account list failed with ${response.status}`);
  }

  const payload = (await response.json()) as {
    result?: EzBookkeepingAccount[];
    success?: boolean;
  };
  if (payload.success === false) {
    throw new Error("ezBookkeeping account list failed");
  }

  return payload.result || [];
}

export async function createTransactionCategory(
  config: AppConfig,
  input: {
    categoryType: BookkeepingCategoryType;
    name: string;
    parentId: string;
    icon?: string;
    color?: string;
    comment?: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<EzBookkeepingCategory> {
  const { baseUrl, token } = requireApiConfig(config);
  const response = await fetchImpl(`${baseUrl}/api/v1/transaction/categories/add.json`, {
    method: "POST",
    headers: apiHeaders(token),
    body: JSON.stringify({
      type: CATEGORY_TYPE_IDS[input.categoryType],
      name: titleCaseName(input.name),
      parentId: input.parentId,
      icon: input.icon || "1",
      color: input.color || "000000",
      comment: input.comment || "Created by FinOps assistant",
      hidden: false,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`ezBookkeeping category add failed with ${response.status}: ${body.slice(0, 200)}`);
  }

  const payload = (await response.json()) as {
    result?: EzBookkeepingCategory;
    success?: boolean;
  };
  if (payload.success === false || !payload.result) {
    throw new Error("ezBookkeeping category add failed");
  }

  return payload.result;
}

export async function ensureTransactionCategory(
  config: AppConfig,
  input: {
    categoryType: BookkeepingCategoryType;
    name: string;
    parentName?: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<EzBookkeepingCategory> {
  const categories = await listTransactionCategories(config, input.categoryType, fetchImpl);
  const categoryName = titleCaseName(input.name);
  const existing = findCategoryByName(categories, categoryName);
  if (existing && existing.parentId !== "0") return existing;

  const parentName = titleCaseName(input.parentName || defaultParentCategory(input.categoryType));
  let parent = categories.find(
    (category) => category.parentId === "0" && category.name.toLowerCase() === parentName.toLowerCase(),
  );

  if (!parent) {
    parent = await createTransactionCategory(
      config,
      {
        categoryType: input.categoryType,
        name: parentName,
        parentId: "0",
      },
      fetchImpl,
    );
  }

  return createTransactionCategory(
    config,
    {
      categoryType: input.categoryType,
      name: categoryName,
      parentId: parent.id,
    },
    fetchImpl,
  );
}

export function buildTransactionRequest(config: AppConfig, transaction: ParsedTransaction): Record<string, unknown> {
  const sourceAccountId = lookup(config.ezBookkeepingAccountIds, transaction.account || transaction.fromAccount);
  const destinationAccountId = lookup(config.ezBookkeepingAccountIds, transaction.toAccount);
  const categoryId = lookup(config.ezBookkeepingCategoryIds, transaction.category || "Account Transfer");
  const sourceAccountIdById = transaction.accountId || sourceAccountId;
  const destinationAccountIdById = transaction.toAccountId || destinationAccountId;
  const categoryIdById = transaction.categoryId || categoryId;

  if (!sourceAccountIdById) {
    throw new Error("missing ezBookkeeping source account mapping");
  }
  if (transaction.type === "transfer" && !destinationAccountIdById) {
    throw new Error("missing ezBookkeeping destination account mapping");
  }
  if (transaction.type !== "transfer" && !categoryIdById) {
    throw new Error("missing ezBookkeeping category mapping");
  }

  const body: Record<string, unknown> = {
    type: transactionType(transaction.type),
    time: Math.floor(new Date(transaction.occurredAt).getTime() / 1000),
    utcOffset: 480,
    sourceAccountId: sourceAccountIdById,
    sourceAmount: cents(transaction.amount),
    comment: [transaction.currency, transaction.note].filter(Boolean).join(" - "),
    hideAmount: false,
    tagIds: [],
    pictureIds: []
  };

  if (categoryIdById) body.categoryId = categoryIdById;
  if (destinationAccountIdById) {
    body.destinationAccountId = destinationAccountIdById;
    body.destinationAmount = cents(transaction.amount);
  }

  return body;
}

export async function writeTransaction(
  config: AppConfig,
  transaction: ParsedTransaction,
  fetchImpl: typeof fetch = fetch
): Promise<EzBookkeepingResult> {
  if (!config.ezBookkeepingBaseUrl || !config.ezBookkeepingApiToken) {
    return { ok: false, error: "ezBookkeeping API not configured" };
  }

  let body: Record<string, unknown>;
  try {
    body = buildTransactionRequest(config, transaction);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "invalid transaction mapping" };
  }

  const response = await fetchImpl(`${config.ezBookkeepingBaseUrl.replace(/\/$/, "")}/api/v1/transactions/add.json`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.ezBookkeepingApiToken}`,
      "Content-Type": "application/json",
      "X-Timezone-Name": config.timezone,
      "X-Timezone-Offset": "480"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    return { ok: false, status: response.status, error: "ezBookkeeping rejected transaction" };
  }

  const payload = (await response.json().catch(() => ({}))) as { result?: { id?: string }; success?: boolean };
  if (payload.success === false) {
    return { ok: false, status: response.status, error: "ezBookkeeping returned unsuccessful response" };
  }

  return { ok: true, status: response.status, transactionId: payload.result?.id };
}
