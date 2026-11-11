/**
 * Application: export / import / import-usage / unclaimed.
 * Local file operations only (no network, no keychain writes): the envelope
 * shapes mirror `claude_swap/transfer.py` so TS output re-imports in Python.
 */

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ReverseLog } from "../../platform/domain/atomicFile.js";
import { ConfigError, ValidationError } from "../../platform/domain/errors.js";
import { readJsonFile } from "../../platform/domain/jsonFile.js";
import {
  backupConfigPath,
  backupCredentialPath,
  encodeBackupCredentials,
  looksLikeApiKey,
  readBackupCredentials,
} from "../adapters/liveCredentials.js";
import { reverseUnlink, updateClaudeSequence } from "../adapters/rosterStore.js";
import type { ClaudeSequence } from "../domain/sequence.js";
import { failed, ok, unhandled, type UseCaseResult } from "./manageAccounts.js";

const accountSchema = z
  .object({
    number: z.number(),
    email: z.string(),
    uuid: z.string().default(""),
    organizationUuid: z.string().default(""),
    organizationName: z.string().default(""),
    added: z.string().default(""),
    credentials: z.unknown(),
    config: z.unknown(),
    kind: z.string().default("oauth"),
    alias: z.string().optional(),
  })
  .catchall(z.unknown());

const envelopeSchema = z
  .object({
    version: z.number(),
    accounts: z.array(accountSchema),
    activeAccountNumber: z.number().nullable().default(null),
  })
  .catchall(z.unknown());

function nowIso(): string {
  return new Date().toISOString();
}

function slimCredentials(creds: unknown): unknown {
  if (typeof creds !== "object" || creds === null) return creds;
  const c = creds as Record<string, unknown>;
  const oauth = c["claudeAiOauth"];
  if (typeof oauth !== "object" || oauth === null) return creds;
  const o = oauth as Record<string, unknown>;
  return {
    claudeAiOauth: {
      refreshToken: o["refreshToken"] ?? "",
      accessToken: o["accessToken"] ?? null,
      expiresAt: o["expiresAt"] ?? null,
      scopes: o["scopes"] ?? [],
    },
  };
}

export function exportAccounts(
  root: string,
  destination: string,
  account: string | null,
  full: boolean,
  readLive: (slot: string) => { creds: string; config: string } | null,
): UseCaseResult {
  try {
    const reverse = new ReverseLog();
    const { sequence } = loadClaudeRoster(root);
    const nums = Object.keys(sequence.accounts).sort((a, b) => Number(a) - Number(b));
    if (nums.length === 0) {
      throw new ConfigError("no accounts to export — run ccswap add first");
    }
    let targets = nums;
    if (account !== null) {
      const resolved = resolveTarget(sequence, account);
      if (resolved === null) throw new ConfigError(`account not found: ${account}`);
      targets = [resolved];
    }
    const payload: Array<Record<string, unknown>> = [];
    for (const num of targets) {
      const rec = sequence.accounts[num];
      if (!rec) continue;
      const live = readLiveForSlot(targets, num, readLive);
      const credsText: string | null = live?.creds ?? readBackupCredentials(backupCredentialPath(root, num, rec.email));
      const configText: string | null =
        live?.config ?? readConfigText(root, num, rec.email);
      if (!credsText || !configText) {
        if (account !== null) {
          if (!credsText) throw new ConfigError(`no backup credentials found for account ${num} (${rec.email})`);
          throw new ConfigError(`no backup config found for account ${num} (${rec.email})`);
        }
        continue; // skip broken slots in the all-accounts case (Python parity)
      }
      const isApiKey = looksLikeApiKey(credsText);
      let credsPayload: unknown;
      if (isApiKey) {
        credsPayload = credsText.trim();
      } else {
        const parsed = JSON.parse(credsText) as unknown;
        credsPayload = full ? parsed : slimCredentials(parsed);
      }
      let configObj: unknown = JSON.parse(configText) as unknown;
      if (!full && typeof configObj === "object" && configObj !== null) {
        const c = configObj as Record<string, unknown>;
        configObj = { oauthAccount: c["oauthAccount"] ?? null };
      }
      const entry: Record<string, unknown> = {
        number: Number(num),
        email: rec.email,
        uuid: rec.uuid,
        organizationUuid: rec.organizationUuid,
        organizationName: rec.organizationName,
        added: rec.added,
        credentials: credsPayload,
        config: configObj,
      };
      if (isApiKey) entry["kind"] = "api_key";
      if (rec.alias !== undefined) entry["alias"] = rec.alias;
      payload.push(entry);
    }
    if (payload.length === 0) {
      throw new ConfigError("no exportable accounts — all managed slots are missing stored credentials/config");
    }
    const exportedNums = new Set(payload.map((a) => a["number"]));
    const envelope = {
      version: 1,
      exportedAt: nowIso(),
      exportedFrom: process.platform,
      encrypted: false,
      activeAccountNumber: sequence.activeAccountNumber !== null && exportedNums.has(sequence.activeAccountNumber)
        ? sequence.activeAccountNumber
        : null,
      accounts: payload,
    };
    const serialized = `${JSON.stringify(envelope, null, 2)}\n`;
    if (destination === "-") {
      return ok(`Exported ${String(payload.length)} account(s)`, { stdout: serialized }, reverse);
    }
    const outPath = path.resolve(destination);
    reverse.record(outPath);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, serialized);
    return ok(`Exported ${String(payload.length)} account(s) to ${outPath}`, undefined, reverse);
  } catch (err) {
    return failed(err);
  }
}

function readLiveForSlot(
  _targets: string[],
  _num: string,
  _readLive: (slot: string) => { creds: string; config: string } | null,
): { creds: string; config: string } | null {
  return _readLive(_num);
}

function readConfigText(root: string, slot: string, email: string): string | null {
  try {
    return fs.readFileSync(backupConfigPath(root, slot, email), "utf-8");
  } catch {
    return null;
  }
}

function resolveTarget(sequence: ClaudeSequence, account: string): string | null {
  const id = account.trim();
  if (/^\d+$/.test(id)) {
    const s = String(Number(id));
    return sequence.accounts[s] !== undefined ? s : null;
  }
  const lowered = id.toLowerCase();
  for (const [slot, rec] of Object.entries(sequence.accounts)) {
    if (rec.alias !== undefined && rec.alias.toLowerCase() === lowered) return slot;
  }
  const hits = Object.entries(sequence.accounts)
    .filter(([, rec]) => rec.email === id)
    .map(([slot]) => slot);
  return hits.length === 1 ? (hits[0] as string) : null;
}

import { loadClaudeRoster } from "../adapters/roster.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function importAccounts(
  root: string,
  source: string,
  readSource: (source: string) => string,
  force: boolean,
  readLiveForActive?: (slot: string) => { creds: string; config: string } | null,
): UseCaseResult {
  void readLiveForActive;
  try {
    const reverse = new ReverseLog();
    let text: string;
    try {
      text = readSource(source);
    } catch {
      throw new ConfigError(`usage file not found: ${source}`);
    }
    let envelope: z.output<typeof envelopeSchema>;
    try {
      envelope = envelopeSchema.parse(JSON.parse(text));
    } catch {
      throw new ConfigError("malformed import file");
    }
    if (envelope.version !== 1) {
      throw new ConfigError(`unsupported import version: ${String(envelope.version)}`);
    }
    // Validate every row before writing any (Python parity).
    for (const row of envelope.accounts) {
      if (!EMAIL_RE.test(row.email)) throw new ValidationError(`invalid email in import: ${row.email}`);
      if (row.credentials === null || row.credentials === undefined) {
        throw new ConfigError(`account ${row.email} has no credentials`);
      }
      if (typeof row.config !== "object" || row.config === null) {
        throw new ConfigError(`account ${row.email} has no config`);
      }
    }
    let imported = 0;
    let skipped = 0;
    const out = updateClaudeSequence(root, reverse, (seq) => {
      const next: ClaudeSequence = {
        ...seq,
        accounts: { ...seq.accounts },
        sequence: [...seq.sequence],
      };
      for (const row of envelope.accounts) {
        const slot = String(row.number);
        const exists = next.accounts[slot] !== undefined;
        if (exists && !force) {
          skipped++;
          continue;
        }
        const credsText = typeof row.credentials === "string"
          ? row.credentials
          : JSON.stringify(row.credentials);
        const configText = JSON.stringify(row.config);
        const email = row.email;
        reverse.record(backupCredentialPath(root, slot, email));
        writeEncFile(root, slot, email, credsText);
        reverse.record(backupConfigPath(root, slot, email));
        fs.mkdirSync(path.dirname(backupConfigPath(root, slot, email)), { recursive: true });
        fs.writeFileSync(backupConfigPath(root, slot, email), `${configText}\n`);
        next.accounts[slot] = {
          email,
          uuid: row.uuid,
          organizationUuid: row.organizationUuid,
          organizationName: row.organizationName,
          added: row.added || nowIso(),
          ...(row.alias !== undefined ? { alias: row.alias } : {}),
          disabled: next.accounts[slot]?.disabled ?? false,
        };
        if (!next.sequence.includes(Number(slot))) next.sequence.push(Number(slot));
        next.sequence.sort((a, b) => a - b);
        imported++;
      }
      next.lastUpdated = nowIso();
      return { seq: next, changed: Object.keys(next.accounts), note: `Imported ${String(imported)} account(s), skipped ${String(skipped)}` };
    });
    void out;
    return ok(`Imported ${String(imported)} account(s), skipped ${String(skipped)}`, undefined, reverse);
  } catch (err) {
    return failed(err);
  }
}


function writeEncFile(root: string, slot: string, email: string, credsText: string): void {
  const file = backupCredentialPath(root, slot, email);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = credsText.trim().startsWith("{") ? encodeBackupCredentials(credsText) : `${credsText.trim()}\n`;
  fs.writeFileSync(file, body);
}

// ---- import-usage --------------------------------------------------------------

const usageRowSchema = z
  .object({
    email: z.string(),
    organizationUuid: z.string().default(""),
    usageStatus: z.string().default(""),
    usage: z.unknown().nullable().default(null),
    usageAgeSeconds: z.number().default(0),
  })
  .catchall(z.unknown());

const usageDocSchema = z
  .object({ schemaVersion: z.number(), accounts: z.array(usageRowSchema) })
  .catchall(z.unknown());

export function importUsage(
  root: string,
  source: string,
  readSource: (source: string) => string,
  holdS: number | null,
): UseCaseResult {
  try {
    const reverse = new ReverseLog();
    let text: string;
    try {
      text = readSource(source);
    } catch {
      throw new ConfigError(`usage file not found: ${source}`);
    }
    let document: unknown;
    try {
      document = JSON.parse(text) as unknown;
    } catch {
      throw new ConfigError("malformed usage document");
    }
    if (typeof document === "object" && document !== null && "claude" in document) {
      document = (document as Record<string, unknown>)["claude"];
    }
    let doc: z.output<typeof usageDocSchema>;
    try {
      doc = usageDocSchema.parse(document);
    } catch {
      throw new ConfigError("malformed usage document");
    }
    if (doc.schemaVersion !== 1) {
      throw new ConfigError(`unsupported usage document schemaVersion: ${String(doc.schemaVersion)}`);
    }
    const { sequence } = loadClaudeRoster(root);
    let adopted = 0;
    let skipped = 0;
    const cacheFile = path.join(root, "cache", "usage.json");
    const rawCache = readJsonFile(cacheFile) as {
      schemaVersion?: number;
      accounts?: Record<string, Record<string, unknown>>;
    } | null;
    const accounts: Record<string, Record<string, unknown>> = { ...(rawCache?.accounts ?? {}) };
    for (const row of doc.accounts) {
      if (!EMAIL_RE.test(row.email)) throw new ValidationError(`invalid email in usage document: ${row.email}`);
      if (row.usageStatus !== "ok") {
        skipped++;
        continue;
      }
      if (!Number.isFinite(row.usageAgeSeconds) || row.usageAgeSeconds < 0) {
        throw new ConfigError(`usageAgeSeconds for ${row.email} must be a non-negative number`);
      }
      const slot = Object.entries(sequence.accounts).find(
        ([, rec]) => rec.email === row.email && rec.organizationUuid === row.organizationUuid,
      )?.[0];
      if (slot === undefined) {
        skipped++;
        continue;
      }
      const prev = accounts[slot] as { fetchedAt?: number } | undefined;
      const fetchedAt = Date.now() / 1000 - row.usageAgeSeconds;
      if (prev !== undefined && typeof prev.fetchedAt === "number" && prev.fetchedAt > fetchedAt) {
        continue; // keep the newer local reading (Python adopt parity)
      }
      accounts[slot] = {
        email: row.email,
        organizationUuid: row.organizationUuid,
        fetchedAt,
        lastGood: row.usage,
        lastError: null,
        ...(holdS !== null ? { holdUntil: Date.now() / 1000 + holdS } : {}),
      };
      adopted++;
    }
    reverse.record(cacheFile);
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, `${JSON.stringify({ schemaVersion: 2, accounts }, null, 2)}\n`);
    const holdNote = holdS !== null && adopted > 0
      ? holdS > 0 ? `; fetching held for up to ${String(holdS)}s` : "; holds lifted"
      : "";
    return ok(`Done: ${String(adopted)} adopted, ${String(skipped)} skipped${holdNote}`, undefined, reverse);
  } catch (err) {
    return failed(err);
  }
}

// ---- unclaimed --------------------------------------------------------------------

const manifestSchema = z
  .object({ entries: z.record(z.string(), z.unknown()).default({}) })
  .catchall(z.unknown());

export function unclaimedManifestPath(root: string): string {
  return path.join(root, "credentials", ".unclaimed-manifest.json");
}

export function listUnclaimed(root: string): { entries: Record<string, Record<string, unknown>> } {
  const raw = readJsonFile(unclaimedManifestPath(root));
  if (raw === null) return { entries: {} };
  try {
    const parsed = manifestSchema.parse(raw);
    const entries: Record<string, Record<string, unknown>> = {};
    for (const [id, meta] of Object.entries(parsed.entries)) {
      entries[id] = typeof meta === "object" && meta !== null
        ? (meta as Record<string, unknown>)
        : { reason: "orphaned (no manifest row)" };
    }
    // Orphaned bytes with no manifest row still list (Python parity).
    try {
      for (const name of fs.readdirSync(path.join(root, "credentials"))) {
        const m = /^\.unclaimed-(.+)\.enc$/.exec(name);
        if (m && entries[m[1] as string] === undefined) {
          entries[m[1] as string] = { reason: "orphaned (no manifest row)" };
        }
      }
    } catch {
      // No credentials dir → no orphans.
    }
    return { entries };
  } catch {
    throw new ConfigError("the unclaimed manifest is unreadable");
  }
}

export function purgeUnclaimed(root: string, id: string): UseCaseResult {
  try {
    const reverse = new ReverseLog();
    const { entries } = listUnclaimed(root);
    if (entries[id] === undefined) {
      return { code: 1, message: `no unclaimed entry ${id}`, reverse, handled: true };
    }
    reverseUnlink(root, reverse, path.join(root, "credentials", `.unclaimed-${id}.enc`));
    const manifestFile = unclaimedManifestPath(root);
    const raw = readJsonFile(manifestFile) as { entries?: Record<string, unknown> } | null;
    const entriesTable = raw?.entries;
    if (entriesTable?.[id] !== undefined) {
      reverse.record(manifestFile);
      const { [id]: _purged, ...kept } = entriesTable;
      void _purged;
      fs.writeFileSync(manifestFile, `${JSON.stringify({ ...raw, entries: kept }, null, 2)}\n`);
    }
    return ok(`Purged ${id}`, undefined, reverse);
  } catch (err) {
    return failed(err);
  }
}

export function unhandledExport(reason: string): UseCaseResult {
  return unhandled(reason);
}
