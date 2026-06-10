import { createHash } from "node:crypto";
import { unlinkSync } from "node:fs";
import { SnapshotEnvelope } from "./portfolioSync";

export interface ImportDateRange {
  from: string;
  to: string;
}

export interface ImportHistoryStore {
  get(checksum: string): SnapshotEnvelope | undefined;
  set(checksum: string, snapshot: SnapshotEnvelope): void;
}

const importHistory = new Map<string, SnapshotEnvelope>();

export const defaultImportHistoryStore: ImportHistoryStore = {
  get(key: string) {
    return importHistory.get(key);
  },
  set(key: string, snapshot: SnapshotEnvelope) {
    importHistory.set(key, snapshot);
  }
};

export function importHistoryKey(params: {
  brokerId: string;
  accountAlias: string;
  sourceType: string;
  checksum: string;
}): string {
  return `${params.brokerId}|${params.accountAlias}|${params.sourceType}|${params.checksum}`;
}

export function resolveImportChecksum(filePath: string, readFile: (path: string) => string, provided?: string): string {
  if (provided && provided.trim()) return provided.trim();

  const content = readFile(filePath);
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

export function parseDateRange(values: string[]): ImportDateRange | undefined {
  const normalized = values
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((value) => Number.isFinite(Date.parse(value)))
    .sort();

  if (normalized.length === 0) return undefined;

  return {
    from: normalized[0]!,
    to: normalized[normalized.length - 1]!
  };
}

export function sanitizeFormulaLikeText(value: string): string {
  if (!value) return value;
  const trimmed = value.trimStart();
  if (trimmed.length === 0) return value;
  if (trimmed[0] === "=" || trimmed[0] === "+" || trimmed[0] === "-" || trimmed[0] === "@") {
    return `'${value}`;
  }
  return value;
}

export function deleteRawImportFile(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch (error) {
    const errno = (error as { code?: string }).code;
    if (errno === "ENOENT") {
      return;
    }
    throw error;
  }
}
