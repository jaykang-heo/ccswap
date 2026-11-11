/** Application: read-only account listing payloads (roster + cached usage). */

import { loadAgyRoster, loadClaudeRoster, loadCodexRoster, normalizeClaude } from "../adapters/roster.js";
import { liveIdentity } from "../adapters/liveIdentity.js";
import { backupRoot } from "../../platform/domain/paths.js";
import type { NormalizedAccount } from "../domain/sequence.js";
import { loadClaudeUsage } from "../../usage/application/readUsage.js";

export interface AccountsPayload {
  schemaVersion: 1;
  provider: string;
  liveRefresh: false;
  accounts: (NormalizedAccount & { usageCached: boolean })[];
  active: string | null;
  /** Where `active` came from: live login, or a wave-1 gap. */
  activeSource: "live" | "unimplemented";
  rosterUnreadable: boolean;
}

/**
 * Live-matched Claude slot (Python parity: list/status `active` comes from
 * the live login, never from `sequence.activeAccountNumber`).
 */
export function claudeActiveSlot(root?: string): string | null {
  const resolved = root ?? backupRoot();
  const live = liveIdentity();
  if (live === null) return null;
  const { sequence } = loadClaudeRoster(resolved);
  return (
    [...sequence.sequence]
      .sort((a, b) => a - b)
      .map(String)
      .find((n) => {
        const rec = sequence.accounts[n];
        return (
          rec !== undefined &&
          rec.email === live.email &&
          rec.organizationUuid === live.organizationUuid
        );
      }) ?? null
  );
}
function withUsage(accounts: NormalizedAccount[], root: string): AccountsPayload["accounts"] {
  const usage = new Map(loadClaudeUsage(root).map((u) => [u.slot, u]));
  return accounts.map((a) => ({ ...a, usageCached: usage.has(a.slot) }));
}

export function claudeAccountsPayload(root?: string): AccountsPayload {
  const resolved = root ?? backupRoot();
  const { sequence, unreadable } = loadClaudeRoster(resolved);
  const active = claudeActiveSlot(resolved);
  const accounts = normalizeClaude(sequence, active).map((a) => a);
  return {
    schemaVersion: 1,
    provider: "claude",
    liveRefresh: false,
    accounts: withUsage(accounts, resolved),
    active,
    activeSource: "live" as const,
    rosterUnreadable: unreadable,
  };
}

export function codexAccountsPayload(root?: string): AccountsPayload {
  const { sequence, unreadable } = loadCodexRoster(root);
  const order = [...sequence.sequence].sort((a, b) => a - b);
  const seen = new Set<number>();
  const accounts: NormalizedAccount[] = [];
  for (const n of [...order, ...Object.keys(sequence.accounts).map(Number)]) {
    if (seen.has(n)) continue;
    seen.add(n);
    const rec = sequence.accounts[String(n)];
    if (!rec) continue;
    accounts.push({
      slot: String(n),
      email: rec.email,
      alias: rec.alias ?? null,
      // Wave 1: Codex live matching (`~/.codex/auth.json` email+workspace)
      // is not implemented; active stays null (Python parity when logged out).
      active: false,
      disabled: rec.disabled,
      organizationName: "",
    });
  }
  return {
    schemaVersion: 1,
    provider: "codex",
    liveRefresh: false,
    accounts: accounts.map((a) => ({ ...a, usageCached: false })),
    active: null,
    activeSource: "unimplemented" as const,
    rosterUnreadable: unreadable,
  };
}

export function agyAccountsPayload(root?: string): AccountsPayload {
  const { accounts, unreadable } = loadAgyRoster(root);
  const list: NormalizedAccount[] = Object.entries(accounts.accounts).map(([slot, rec]) => ({
    slot,
    email: rec.email,
    alias: rec.alias ?? null,
    // Wave 1: Agy live matching (native login credential) is not
    // implemented; active stays null (Python parity when logged out).
    active: false,
    disabled: false,
    organizationName: "",
  }));
  return {
    schemaVersion: 1,
    provider: "agy",
    liveRefresh: false,
    accounts: list.map((a) => ({ ...a, usageCached: false })),
    active: null,
    activeSource: "unimplemented" as const,
    rosterUnreadable: unreadable,
  };
}

export function renderAccountsHuman(provider: string, accounts: AccountsPayload["accounts"]): string[] {
  if (accounts.length === 0) return [`No ${provider} accounts registered.`];
  return accounts.map((a) => {
    const mark = a.active ? "*" : " ";
    const alias = a.alias !== null ? ` (alias: ${a.alias})` : "";
    const disabled = a.disabled ? " [disabled]" : "";
    return `${mark} [${a.slot}] ${a.email}${alias}${disabled}`;
  });
}
