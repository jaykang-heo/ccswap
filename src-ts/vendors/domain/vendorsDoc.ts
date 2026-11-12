/**
 * Zod schemas for `<backup>/vendors/vendors.json` (schemaVersion 1).
 * Mirrors `claude_swap/vendors/store.py`. Corrupt entries are skipped but
 * preserved on disk by Python; TS likewise skips them when reading.
 */

import { z } from 'zod';

const ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,63}$/;
const SECRET_REF_RE = /^[a-z]+-[0-9a-f]{32}$/;

const accountSchema = z
  .object({
    alias: z.string(),
    kind: z.string().default(''),
    provider: z.string().nullable().default(null),
    identity: z.record(z.string(), z.string()).default({}),
    loginHint: z.string().default(''),
    secretRef: z
      .string()
      .nullable()
      .default(null)
      .refine((v) => v === null || SECRET_REF_RE.test(v), { message: 'bad secretRef' }),
  })
  .catchall(z.unknown());

export type VendorAccount = z.output<typeof accountSchema>;

const toolEntrySchema = z
  .object({
    accounts: z.array(z.unknown()).default([]),
    active: z.string().nullable().default(null),
  })
  .catchall(z.unknown());

export const vendorsDocSchema = z
  .object({
    schemaVersion: z.number(),
    tools: z.record(z.string(), toolEntrySchema).default({}),
  })
  .catchall(z.unknown());

export type VendorsDoc = z.output<typeof vendorsDocSchema>;

export function validAlias(alias: string): boolean {
  return ALIAS_RE.test(alias);
}

export function parseVendorAccounts(rawAccounts: unknown[]): VendorAccount[] {
  const out: VendorAccount[] = [];
  for (const raw of rawAccounts) {
    try {
      const parsed = accountSchema.parse(raw);
      if (!validAlias(parsed.alias)) continue;
      out.push(parsed);
    } catch {
      continue; // corrupted entry: skipped, preserved on disk (Python parity)
    }
  }
  return out;
}
