/** Zod schemas for `<backup>/mappings.json`. Mirrors `MappingStore`. */

import { z } from 'zod';

const entrySchema = z
  .object({
    email: z.string().default(''),
    organizationUuid: z.string().default(''),
    added: z.string().default(''),
  })
  .catchall(z.unknown());

export type MappingEntry = z.output<typeof entrySchema>;

export const mappingsDocSchema = z
  .object({
    schemaVersion: z.number().default(1),
    mappings: z.record(z.string(), entrySchema).default({}),
  })
  .catchall(z.unknown());

export type MappingsDoc = z.output<typeof mappingsDocSchema>;

import fs from 'node:fs';
import path from 'node:path';

/** Normalize a path to a stable mapping key (expanduser + resolve). */
export function normalizeMappingPath(p: string): string {
  let expanded = p;
  if (expanded === '~') expanded = process.env['HOME'] ?? expanded;
  else if (expanded.startsWith('~/')) expanded = `${process.env['HOME'] ?? '~'}${expanded.slice(1)}`;
  try {
    return fs.realpathSync(expanded);
  } catch {
    return path.resolve(expanded);
  }
}
