/** Live Claude identity: `(email, orgUuid)` from the global config. */

import { z } from 'zod';
import { readJsonFile } from '../../platform/domain/jsonFile.js';
import { claudeGlobalConfigPath } from '../../platform/domain/paths.js';

const oauthAccountSchema = z
  .object({
    emailAddress: z.string().default(''),
    organizationUuid: z.string().nullable().default(null),
    accountUuid: z.string().nullable().default(null),
  })
  .catchall(z.unknown());

const globalConfigSchema = z
  .object({
    oauthAccount: oauthAccountSchema.catch({ emailAddress: '', organizationUuid: null, accountUuid: null }),
  })
  .catchall(z.unknown());

export interface LiveIdentity {
  email: string;
  organizationUuid: string;
}

/** Null when there is no live login (mirrors `_get_current_account`). */
export function liveIdentity(configPath: string = claudeGlobalConfigPath()): LiveIdentity | null {
  const raw = readJsonFile(configPath);
  if (raw === null) return null;
  try {
    const parsed = globalConfigSchema.parse(raw);
    if (parsed.oauthAccount.emailAddress === '') return null;
    return {
      email: parsed.oauthAccount.emailAddress,
      organizationUuid: parsed.oauthAccount.organizationUuid ?? '',
    };
  } catch {
    return null;
  }
}
