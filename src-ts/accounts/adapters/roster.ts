/** Roster adapters: read-only loads of the Claude/Codex/Agy rosters. */

import path from "node:path";
import { readJsonFile } from "../../platform/domain/jsonFile.js";
import { backupRoot } from "../../platform/domain/paths.js";
import {
  type AgyAccounts,
  agyAccountsSchema,
  type ClaudeSequence,
  claudeSequenceSchema,
  type CodexSequence,
  codexSequenceSchema,
  type NormalizedAccount,
} from "../domain/sequence.js";

function parseOrEmpty<T>(parse: (v: unknown) => T, raw: unknown, fallback: T): T {
  if (raw === null || raw === undefined) return fallback;
  try {
    return parse(raw);
  } catch {
    // Corrupt roster: Python refuses to overwrite it; TS reports it as empty
    // and surfaces the condition via `rosterUnreadable` on the payload.
    return fallback;
  }
}

const EMPTY_CLAUDE: ClaudeSequence = {
  accounts: {},
  sequence: [],
  activeAccountNumber: null,
  lastUpdated: "",
};

const EMPTY_CODEX: CodexSequence = { accounts: {}, sequence: [], activeAccountNumber: null };

const EMPTY_AGY: AgyAccounts = { accounts: {}, activeAccountNumber: null };

export interface RosterLoad<S = ClaudeSequence> {
  sequence: S;
  unreadable: boolean;
}

export function loadClaudeRoster(root: string = backupRoot()): RosterLoad {
  const raw = readJsonFile(path.join(root, "sequence.json"));
  if (raw === null) return { sequence: EMPTY_CLAUDE, unreadable: true };
  return { sequence: parseOrEmpty((v) => claudeSequenceSchema.parse(v) as ClaudeSequence, raw, EMPTY_CLAUDE), unreadable: false };
}

export function loadCodexRoster(root: string = backupRoot()): RosterLoad<CodexSequence> {
  const raw = readJsonFile(path.join(root, "codex", "sequence.json"));
  if (raw === null)
    return { sequence: EMPTY_CODEX, unreadable: true };
  return { sequence: parseOrEmpty((v) => codexSequenceSchema.parse(v) as CodexSequence, raw, EMPTY_CODEX), unreadable: false };
}

export function loadAgyRoster(root: string = backupRoot()): {
  accounts: AgyAccounts;
  unreadable: boolean;
} {
  const raw = readJsonFile(path.join(root, "agy", "accounts.json"));
  if (raw === null) return { accounts: EMPTY_AGY, unreadable: true };
  return { accounts: parseOrEmpty((v) => agyAccountsSchema.parse(v) as AgyAccounts, raw, EMPTY_AGY), unreadable: false };
}

export function normalizeClaude(seq: ClaudeSequence, activeSlot: string | null): NormalizedAccount[] {
  const order = [...seq.sequence].sort((a, b) => a - b);
  const seen = new Set<number>();
  const out: NormalizedAccount[] = [];
  for (const n of [...order, ...Object.keys(seq.accounts).map(Number)]) {
    if (seen.has(n)) continue;
    seen.add(n);
    const rec = seq.accounts[String(n)];
    if (!rec) continue;
    out.push({
      slot: String(n),
      email: rec.email,
      alias: rec.alias ?? null,
      active: activeSlot !== null && activeSlot === String(n),
      disabled: rec.disabled,
      organizationName: rec.organizationName,
    });
  }
  return out;
}
