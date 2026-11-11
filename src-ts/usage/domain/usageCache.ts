/**
 * Zod schemas for the usage caches. Mirrors:
 * - `<backup>/cache/usage.json` (schemaVersion 2, `accounts` keyed by slot)
 * - `<backup>/vendors/usage.json` (`entries` keyed by `"<tool>\\x1f<account>"`)
 * Only the stored last-good rows are read; live refresh stays in Python.
 */

import { z } from "zod";

const usageWindowSchema = z
  .object({
    key: z.string(),
    label: z.string().default(""),
    unit: z.string().default(""),
    used: z.number().nullable().default(null),
    limit: z.number().nullable().default(null),
    remaining: z.number().nullable().default(null),
    usedPercent: z.number().nullable().default(null),
    resetsAt: z.number().nullable().default(null),
    scope: z.string().default("account"),
    note: z.string().default(""),
    resetsOn: z.string().nullable().default(null),
  })
  .catchall(z.unknown());

export type UsageWindow = z.output<typeof usageWindowSchema>;

const claudeUsageRow = z
  .object({
    email: z.string().default(""),
    organizationUuid: z.string().default(""),
    fetchedAt: z.number().nullable().default(null),
    lastGood: z.unknown().nullable().default(null),
    lastError: z.string().nullable().default(null),
    consecutiveFailures: z.number().default(0),
    nextPollAt: z.number().nullable().default(null),
  })
  .catchall(z.unknown());

export const claudeUsageSchema = z
  .object({
    schemaVersion: z.number(),
    accounts: z.record(z.string(), claudeUsageRow).default({}),
  })
  .catchall(z.unknown());

export type ClaudeUsageTable = z.output<typeof claudeUsageSchema>;

export const vendorUsageResultSchema = z
  .object({
    state: z.string(),
    reason: z.string().default(""),
    hint: z.string().default(""),
    windows: z.array(usageWindowSchema).default([]),
    observations: z.array(z.unknown()).default([]),
    plan: z.string().nullable().default(null),
    source: z.string().default(""),
    authoritative: z.boolean().default(false),
    attributedTo: z.string().nullable().default(null),
    observedAt: z.number().nullable().default(null),
    error: z.string().nullable().default(null),
  })
  .catchall(z.unknown());

export type VendorUsageResult = z.output<typeof vendorUsageResultSchema>;

export const vendorUsageCacheSchema = z
  .object({
    schemaVersion: z.number(),
    entries: z.record(z.string(), vendorUsageResultSchema).default({}),
  })
  .catchall(z.unknown());

export type VendorUsageCache = z.output<typeof vendorUsageCacheSchema>;
