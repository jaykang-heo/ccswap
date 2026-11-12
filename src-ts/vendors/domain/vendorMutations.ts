/**
 * Pure vendor-roster mutations. Secrets never flow through the doc; the
 * adapter writes `<tool>-<32hex>.secret` files (0600) and only the ref lands
 * in `vendors.json`. Every mutation states its reverse (prior doc bytes +
 * touched secret files) for the adapter to record.
 */

import { randomBytes } from 'node:crypto';
import { ConfigError, UnsupportedCapability, ValidationError } from '../../platform/domain/errors.js';
import { validAlias, type VendorAccount, type VendorsDoc } from './vendorsDoc.js';

export interface VendorMutation {
  doc: VendorsDoc;
  secretWrite: { alias: string; secret: string } | null;
  secretDrop: string | null;
  detail: string;
}

export function newSecretRef(tool: string): string {
  const prefix = tool.toLowerCase().replace(/[^a-z]/g, '') || 'vendor';
  return `${prefix}-${randomBytes(16).toString('hex')}`;
}

/** Provider-aware lookup: an alias may repeat per provider in stored data. */
export function findVendorIndex(accounts: VendorAccount[], identifier: string, provider?: string): number {
  if (/^\d+$/.test(identifier.trim())) {
    const idx = Number(identifier.trim()) - 1;
    if (idx >= 0 && idx < accounts.length) return idx;
    throw new ConfigError(`Unknown account '${identifier}'`);
  }
  const hits = accounts
    .map((a, i) => ({ a, i }))
    .filter(({ a }) => a.alias === identifier && (provider === undefined || a.provider === provider));
  if (hits.length === 0) throw new ConfigError(`Unknown account '${identifier}'`);
  if (hits.length > 1) {
    throw new ValidationError(`Multiple accounts named '${identifier}'; pass --provider`);
  }
  return (hits[0] as { i: number }).i;
}

function toolEntry(doc: VendorsDoc, tool: string): { accounts: unknown[]; active: string | null } {
  const entry = doc.tools[tool] as { accounts?: unknown; active?: unknown } | undefined;
  const rawAccounts: unknown[] = entry !== undefined && Array.isArray(entry.accounts) ? entry.accounts : [];
  const accounts = [...rawAccounts];
  const active = entry !== undefined && typeof entry.active === 'string' ? entry.active : null;
  return { accounts, active };
}

export function vendorAddMutation(
  doc: VendorsDoc,
  tool: string,
  account: {
    alias: string;
    kind: string;
    provider?: string | null;
    identity?: Record<string, string>;
    loginHint?: string;
  },
  secret: string | null,
): VendorMutation {
  if (!validAlias(account.alias)) {
    throw new ValidationError(`bad alias '${account.alias}'`);
  }
  const entry = toolEntry(doc, tool);
  const existing = (entry.accounts as Array<Record<string, unknown>>).find(
    (a) => a['alias'] === account.alias,
  );
  if (existing) {
    throw new ConfigError(`'${account.alias}' is already registered for ${tool}`);
  }
  const needsSecret = account.kind === 'api-key';
  if (needsSecret && !secret) {
    throw new ConfigError('an API-key account needs a secret (stdin or prompt)');
  }
  const secretRef = needsSecret && secret ? newSecretRef(tool) : null;
  const record: Record<string, unknown> = {
    alias: account.alias,
    kind: account.kind,
    provider: account.provider ?? null,
    identity: account.identity ?? {},
    loginHint: account.loginHint ?? '',
    secretRef,
  };
  return {
    doc: {
      ...doc,
      tools: { ...doc.tools, [tool]: { accounts: [...entry.accounts, record], active: entry.active } },
    },
    secretWrite: secretRef && secret ? { alias: secretRef, secret } : null,
    secretDrop: null,
    detail: `Registered ${account.alias} for ${tool}`,
  };
}

export function vendorRemoveMutation(
  doc: VendorsDoc,
  tool: string,
  identifier: string,
  provider?: string,
  accounts?: VendorAccount[],
): VendorMutation & { removed: VendorAccount } {
  const entry = toolEntry(doc, tool);
  const parsed = accounts ?? [];
  const idx = findVendorIndex(parsed, identifier, provider);
  const removed = parsed[idx] as VendorAccount;
  const raw = entry.accounts as Array<Record<string, unknown>>;
  const rawIdx = raw.findIndex(
    (a) => a['alias'] === removed.alias && (provider === undefined || (a['provider'] ?? null) === provider),
  );
  const next = [...entry.accounts];
  if (rawIdx >= 0) next.splice(rawIdx, 1);
  const active = entry.active === removed.alias ? null : entry.active;
  return {
    doc: { ...doc, tools: { ...doc.tools, [tool]: { accounts: next, active } } },
    secretWrite: null,
    secretDrop: removed.secretRef ?? null,
    detail: `Removed ${removed.alias} from ${tool}`,
    removed,
  };
}

export function vendorSetActiveMutation(doc: VendorsDoc, tool: string, alias: string): VendorMutation {
  const entry = toolEntry(doc, tool);
  return {
    doc: { ...doc, tools: { ...doc.tools, [tool]: { accounts: entry.accounts, active: alias } } },
    secretWrite: null,
    secretDrop: null,
    detail: `Switched ${tool} to ${alias}`,
  };
}

/** Exit-3 matrix: which switch/run shapes the product cannot do. */
export function switchSupport(tool: string, kind: string): 'file' | 'interactive' | 'unsupported' {
  void kind;
  if (tool === 'muse') return 'file'; // API-key accounts via local files; browser sessions need login
  if (tool === 'kiro') return 'interactive'; // guarded interactive logout/login
  throw new UnsupportedCapability(`the product cannot do it (${tool} switch)`);
}

export function runSupport(tool: string, kind: string): 'file' | 'unsupported' {
  void kind;
  if (tool === 'muse' || tool === 'kiro') return 'file'; // API-key accounts only
  throw new UnsupportedCapability(`not possible (${tool} run)`);
}
