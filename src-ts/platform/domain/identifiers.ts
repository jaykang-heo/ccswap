/**
 * Identifier rules shared by every roster mutation.
 * Mirrors `claude_swap/models.normalize_alias` and the
 * `_resolve_account_identifier` family (`switcher.py`, `codex.py`, `agy.py`).
 */

import { AccountNotFoundError, ValidationError } from "./errors.js";

const ALIAS_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Lowercase and validate; throws ValidationError on invalid (Python parity). */
export function normalizeAlias(name: string): string {
  const normalized = name.trim().toLowerCase();
  if (normalized === "") throw new ValidationError("alias cannot be empty");
  if (/^\d+$/.test(normalized)) {
    throw new ValidationError(
      `alias '${name}' cannot be purely numeric (reserved for slot numbers)`,
    );
  }
  if (normalized.startsWith("-")) {
    throw new ValidationError(
      `alias '${name}' cannot start with '-' (would be read as a command flag)`,
    );
  }
  if (!ALIAS_RE.test(normalized)) {
    throw new ValidationError(
      `alias '${name}' may only contain letters, digits, '-', '_', and '.'`,
    );
  }
  return normalized;
}

export interface ClaudeRecordLike {
  email: string;
  alias?: string | undefined;
}

/**
 * Resolve NUM|EMAIL|ALIAS to a slot number string.
 * - digits → slot when present; - alias (case-insensitive) → its slot;
 * - email → slot when exactly one account has it (ambiguity is an error,
 *   matching session-mode `resolve_account`; the interactive prompt of
 *   `remove_account` stays in Python).
 */
export function resolveClaudeSlot(
  accounts: Record<string, ClaudeRecordLike>,
  identifier: string,
): string {
  const id = identifier.trim();
  if (/^\d+$/.test(id)) {
    const slot = String(Number(id));
    if (accounts[slot] !== undefined) return slot;
    throw new AccountNotFoundError(`No account found with identifier: ${identifier}`);
  }
  const lowered = id.toLowerCase();
  for (const [slot, rec] of Object.entries(accounts)) {
    if (rec.alias !== undefined && rec.alias.toLowerCase() === lowered) return slot;
  }
  const emailHits = Object.entries(accounts)
    .filter(([, rec]) => rec.email === id)
    .map(([slot]) => slot);
  if (emailHits.length === 1) return emailHits[0] as string;
  if (emailHits.length > 1) {
    throw new ValidationError(
      `Multiple accounts found for '${identifier}': ${(emailHits).join(", ")}`,
    );
  }
  throw new AccountNotFoundError(`No account found with identifier: ${identifier}`);
}

/** Vendor aliases are unique per tool; resolution is exact (Python parity). */
export function resolveVendorAlias(aliases: string[], identifier: string): string {
  const hit = aliases.find((a) => a === identifier);
  if (hit === undefined) throw new AccountNotFoundError(`Unknown account '${identifier}'`);
  return hit;
}

/** Smallest positive integer slot not in use (Python `add` parity). */
export function nextFreeSlot(used: Set<number>): number {
  let n = 1;
  while (used.has(n)) n++;
  return n;
}
