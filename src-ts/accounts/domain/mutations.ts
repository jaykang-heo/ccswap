/**
 * Pure roster mutations for the Claude/Codex/Agy sequence docs.
 * Each takes a zod-parsed doc and returns the updated doc plus a human
 * detail line. Persistence (lock + atomic write + reverse log) lives in
 * `adapters/rosterStore.ts`; these functions never touch the filesystem.
 */

import { type AgyAccounts, type ClaudeSequence, type CodexSequence } from './sequence.js';
import { normalizeAlias, resolveClaudeSlot } from '../../platform/domain/identifiers.js';
import { AccountNotFoundError, ConfigError, ValidationError } from '../../platform/domain/errors.js';

export interface MutationResult<T> {
  doc: T;
  detail: string;
}

export function setAliasMutation(
  seq: ClaudeSequence,
  identifier: string,
  alias: string,
  nowIso: string,
): MutationResult<ClaudeSequence> {
  const normalized = normalizeAlias(alias);
  const slot = resolveClaudeSlot(seq.accounts, identifier);
  const record = seq.accounts[slot];
  if (!record) throw new AccountNotFoundError(`Account-${slot} does not exist`);
  for (const [other, rec] of Object.entries(seq.accounts)) {
    if (other !== slot && rec.alias === normalized) {
      throw new ConfigError(`Alias '${normalized}' is already used by account ${other}`);
    }
  }
  return {
    doc: {
      ...seq,
      accounts: { ...seq.accounts, [slot]: { ...record, alias: normalized } },
      lastUpdated: nowIso,
    },
    detail: `Set alias '${normalized}' for Account ${slot}`,
  };
}

export function unsetAliasMutation(
  seq: ClaudeSequence,
  identifier: string,
  nowIso: string,
): MutationResult<ClaudeSequence> {
  const slot = resolveClaudeSlot(seq.accounts, identifier);
  const record = seq.accounts[slot];
  if (!record) throw new AccountNotFoundError(`Account-${slot} does not exist`);
  if (record.alias === undefined) {
    // Idempotent (Python parity: clearing an unset alias succeeds silently).
    return { doc: seq, detail: `Removed alias for Account ${slot}` };
  }
  const { alias: _dropped, ...rest } = record;
  void _dropped;
  return {
    doc: {
      ...seq,
      accounts: { ...seq.accounts, [slot]: rest },
      lastUpdated: nowIso,
    },
    detail: `Removed alias for Account ${slot}`,
  };
}

export function setDisabledMutation(
  seq: ClaudeSequence,
  identifier: string,
  disabled: boolean,
  nowIso: string,
): MutationResult<ClaudeSequence> {
  const slot = resolveClaudeSlot(seq.accounts, identifier);
  const record = seq.accounts[slot];
  if (!record) throw new AccountNotFoundError(`Account-${slot} does not exist`);
  return {
    doc: {
      ...seq,
      accounts: { ...seq.accounts, [slot]: { ...record, disabled } },
      lastUpdated: nowIso,
    },
    detail: `${disabled ? 'Disabled' : 'Enabled'} Account ${slot}`,
  };
}

export interface RemoveMutation {
  doc: ClaudeSequence;
  email: string;
  organizationUuid: string;
  wasActive: boolean;
}

/** Remove the account row; file/keychain/mapping cleanup is the adapter's job. */
export function removeMutation(seq: ClaudeSequence, identifier: string, nowIso: string): RemoveMutation {
  const slot = resolveClaudeSlot(seq.accounts, identifier);
  const record = seq.accounts[slot];
  if (!record) throw new AccountNotFoundError(`Account-${slot} does not exist`);
  const { [slot]: _removedSlot, ...accounts } = seq.accounts;
  void _removedSlot;
  const sequence = seq.sequence.filter((n) => String(n) !== slot);
  const wasActive = seq.activeAccountNumber !== null && String(seq.activeAccountNumber) === slot;
  const remaining = sequence.length > 0 ? [...sequence].sort((a, b) => a - b)[0] : null;
  return {
    doc: {
      ...seq,
      accounts,
      sequence,
      activeAccountNumber: wasActive ? (remaining as number | null) : seq.activeAccountNumber,
      lastUpdated: nowIso,
    },
    email: record.email,
    organizationUuid: record.organizationUuid,
    wasActive,
  };
}

export interface SwapMutation extends MutationResult<ClaudeSequence> {
  slotA: string;
  slotB: string;
}

/** Exchange two slots' records (aliases move with the account). */
export function swapMutation(
  seq: ClaudeSequence,
  first: string,
  second: string,
  nowIso: string,
): SwapMutation {
  const slotA = resolveClaudeSlot(seq.accounts, first);
  const slotB = resolveClaudeSlot(seq.accounts, second);
  if (slotA === slotB) {
    throw new ValidationError('Cannot swap an account with itself');
  }
  const recA = seq.accounts[slotA];
  const recB = seq.accounts[slotB];
  if (!recA || !recB) throw new AccountNotFoundError('Account does not exist');
  const accounts = { ...seq.accounts, [slotA]: recB, [slotB]: recA };
  const sequence = [...seq.sequence].sort((a, b) => a - b);
  const mapActive = (n: number | null): number | null => {
    if (n === null) return null;
    if (String(n) === slotA) return Number(slotB);
    if (String(n) === slotB) return Number(slotA);
    return n;
  };
  return {
    doc: {
      ...seq,
      accounts,
      sequence,
      activeAccountNumber: mapActive(seq.activeAccountNumber),
      lastUpdated: nowIso,
    },
    detail: `Swapped Accounts ${slotA} and ${slotB}`,
    slotA,
    slotB,
  };
}

export interface MoveMutation extends MutationResult<ClaudeSequence> {
  slot: string;
  target: number;
  swapped: boolean;
}

/** Assign an account to a slot; occupied targets swap (Python `move` parity). */
export function moveMutation(
  seq: ClaudeSequence,
  identifier: string,
  targetSlot: string,
  nowIso: string,
): MoveMutation {
  if (!/^\d+$/.test(targetSlot) || Number(targetSlot) < 1) {
    throw new ValidationError(`Invalid slot number: ${targetSlot}`);
  }
  const slot = resolveClaudeSlot(seq.accounts, identifier);
  const target = Number(targetSlot);
  if (slot === String(target)) {
    return {
      doc: seq,
      detail: `Account ${slot} is already in slot ${String(target)}`,
      slot,
      target,
      swapped: false,
    };
  }
  if (seq.accounts[String(target)] !== undefined) {
    const swapped = swapMutation(seq, slot, String(target), nowIso);
    return {
      ...swapped,
      detail: `Swapped Accounts ${slot} and ${String(target)}`,
      slot,
      target,
      swapped: true,
    };
  }
  const record = seq.accounts[slot];
  if (!record) throw new AccountNotFoundError(`Account-${slot} does not exist`);
  const { [slot]: _movedSlot, ...kept } = seq.accounts;
  void _movedSlot;
  const accounts = { ...kept, [String(target)]: record };
  const sequence = [...seq.sequence.filter((n) => String(n) !== slot), target].sort((a, b) => a - b);
  const mapActive = (n: number | null): number | null => (n !== null && String(n) === slot ? target : n);
  return {
    doc: {
      ...seq,
      accounts,
      sequence,
      activeAccountNumber: mapActive(seq.activeAccountNumber),
      lastUpdated: nowIso,
    },
    detail: `Moved Account ${slot} to slot ${String(target)}`,
    slot,
    target,
    swapped: false,
  };
}

/** Generic legacy-store (codex/agy) row removal. */
export function removeLegacyRow<T extends { accounts: Record<string, { email?: string }> }>(
  doc: T,
  identifier: string,
): { doc: T; slot: string; email: string } {
  const accounts = doc.accounts as Record<string, { email?: string; alias?: string }>;
  let slot: string | null = null;
  if (/^\d+$/.test(identifier.trim())) {
    const s = String(Number(identifier.trim()));
    if (accounts[s] !== undefined) slot = s;
  } else {
    const lowered = identifier.trim().toLowerCase();
    for (const [s, rec] of Object.entries(accounts)) {
      if (rec.alias?.toLowerCase() === lowered) {
        slot = s;
        break;
      }
    }
    if (slot === null) {
      const hits = Object.entries(accounts)
        .filter(([, rec]) => rec.email === identifier.trim())
        .map(([s]) => s);
      if (hits.length === 1) slot = hits[0] as string;
      else if (hits.length > 1) {
        throw new ValidationError(`Multiple accounts found for '${identifier}'`);
      }
    }
  }
  if (slot === null || accounts[slot] === undefined) {
    throw new AccountNotFoundError(`No account found with identifier: ${identifier}`);
  }
  const email = accounts[slot]?.email ?? '';
  const { [slot]: _legacySlot, ...next } = accounts;
  void _legacySlot;
  return { doc: { ...doc, accounts: next }, slot, email };
}

export type { ClaudeSequence, CodexSequence, AgyAccounts };
