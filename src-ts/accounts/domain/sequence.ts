/**
 * Zod schemas at the file boundary. Mirrors:
 * - `<backup>/sequence.json` (Claude roster, `ClaudeAccountSwitcher`)
 * - `<backup>/codex/sequence.json` (Codex roster)
 * - `<backup>/agy/accounts.json` (Antigravity roster)
 * - `<backup>/settings.json` (`claude_swap/settings.py`, camelCase)
 */

import { z } from "zod";

const claudeAccountRecord = z
  .object({
    email: z.string().default("unknown"),
    uuid: z.string().default(""),
    organizationUuid: z.string().default(""),
    organizationName: z.string().default(""),
    added: z.string().default(""),
    alias: z.string().optional(),
    disabled: z.boolean().default(false),
  })
  .catchall(z.unknown());

export const claudeSequenceSchema = z
  .object({
    accounts: z.record(z.string(), claudeAccountRecord).default({}),
    sequence: z.array(z.number()).default([]),
    activeAccountNumber: z.number().nullable().default(null),
    lastUpdated: z.string().default(""),
  })
  .catchall(z.unknown());

export interface ClaudeAccountRecord {
  email: string;
  uuid: string;
  organizationUuid: string;
  organizationName: string;
  added: string;
  alias?: string | undefined;
  disabled: boolean;
}

export interface ClaudeSequence {
  accounts: Record<string, ClaudeAccountRecord>;
  sequence: number[];
  activeAccountNumber: number | null;
  lastUpdated: string;
}

const codexAccountRecord = z
  .object({
    email: z.string().default("unknown"),
    alias: z.string().optional(),
    disabled: z.boolean().default(false),
  })
  .catchall(z.unknown());

export const codexSequenceSchema = z
  .object({
    accounts: z.record(z.string(), codexAccountRecord).default({}),
    sequence: z.array(z.number()).default([]),
    activeAccountNumber: z.number().nullable().default(null),
  })
  .catchall(z.unknown());

export interface CodexSequence {
  accounts: Record<string, { email: string; alias?: string | undefined; disabled: boolean }>;
  sequence: number[];
  activeAccountNumber: number | null;
}

const agyAccountRecord = z
  .object({
    email: z.string().default("unknown"),
    alias: z.string().optional(),
  })
  .catchall(z.unknown());

export const agyAccountsSchema = z
  .object({
    accounts: z.record(z.string(), agyAccountRecord).default({}),
    activeAccountNumber: z.number().nullable().default(null),
  })
  .catchall(z.unknown());

export interface AgyAccounts {
  accounts: Record<string, { email: string; alias?: string | undefined }>;
  activeAccountNumber: number | null;
}

export const settingsSchema = z.record(z.string(), z.unknown());

export interface NormalizedAccount {
  slot: string;
  email: string;
  alias: string | null;
  active: boolean;
  disabled: boolean;
  organizationName: string;
}
