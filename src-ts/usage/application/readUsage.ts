/** Read-only usage reads: last-good cached rows, no live refresh. */

import path from 'node:path';
import { readJsonFile } from '../../platform/domain/jsonFile.js';
import { backupRoot } from '../../platform/domain/paths.js';
import {
  type ClaudeUsageTable,
  claudeUsageSchema,
  type VendorUsageCache,
  type VendorUsageResult,
  vendorUsageCacheSchema,
} from '../domain/usageCache.js';

export interface ClaudeSlotUsage {
  slot: string;
  email: string;
  fetchedAt: number | null;
  lastError: string | null;
  lastGood: unknown;
}

export function loadClaudeUsage(root: string = backupRoot()): ClaudeSlotUsage[] {
  const raw = readJsonFile(path.join(root, 'cache', 'usage.json'));
  let table: ClaudeUsageTable | null = null;
  try {
    table = raw === null ? null : claudeUsageSchema.parse(raw);
  } catch {
    table = null;
  }
  if (table === null || table.schemaVersion !== 2) return [];
  return Object.entries(table.accounts).map(([slot, row]) => ({
    slot,
    email: row.email,
    fetchedAt: row.fetchedAt,
    lastError: row.lastError,
    lastGood: row.lastGood,
  }));
}

export function loadVendorUsage(root: string = backupRoot()): VendorUsageCache | null {
  const raw = readJsonFile(path.join(root, 'vendors', 'usage.json'));
  if (raw === null) return null;
  try {
    return vendorUsageCacheSchema.parse(raw);
  } catch {
    // Corrupt cache is treated as empty (Python parity: no crash).
    return { schemaVersion: 1, entries: {} };
  }
}

export function vendorUsageFor(
  cache: VendorUsageCache | null,
  tool: string,
  account: string,
): VendorUsageResult | null {
  if (cache === null) return null;
  return cache.entries[`${tool}\u001f${account}`] ?? null;
}
