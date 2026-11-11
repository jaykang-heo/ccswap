/**
 * Agy legacy store domain. Roster: `agy/accounts.json` plus per-account
 * `account-<n>.json` / `usage-<n>.json`. The shared native login lives
 * outside the backup (Keychain/`agy` CLI custody) — add/switch drive that
 * product and stay in Python; remove is local file bookkeeping (TS).
 */

import { z } from "zod";

export const agyAccountRecordSchema = z
  .object({
    email: z.string().default("unknown"),
    alias: z.string().optional(),
  })
  .catchall(z.unknown());

export type AgyAccountRecord = z.output<typeof agyAccountRecordSchema>;

export const agyRosterSchema = z
  .object({
    accounts: z.record(z.string(), agyAccountRecordSchema).default({}),
    activeAccountNumber: z.number().nullable().default(null),
  })
  .catchall(z.unknown());

export type AgyRoster = z.output<typeof agyRosterSchema>;
