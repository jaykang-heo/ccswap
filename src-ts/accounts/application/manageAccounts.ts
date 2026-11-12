/**
 * Application: mutating Claude roster commands.
 * Every use-case runs under the roster lock with zod at the file boundary
 * and returns `{ code, message, reverse }` — `reverse.rollback()` restores
 * the pre-mutation bytes of every touched file (the strangler reverse path).
 *
 * Ported (file-backed core):
 * alias set/unset, remove, disable/enable, swap, move, add (from the live
 * login), add-token, switch (direct + --strategy on cached usage), unclaimed
 * list/purge, export/import/import-usage.
 *
 * Falls back to Python (`handled: false`) when the mutation needs what TS
 * does not do: the macOS Keychain (keychain-only backups), live session-mode
 * profiles, interactive prompts (ambiguous email, overwrite confirmations
 * without --yes/--force), or the browser OAuth flow (relogin).
 */

import fs from 'node:fs';
import path from 'node:path';
import { ReverseLog, withFileLock } from '../../platform/domain/atomicFile.js';
import { readJsonFile, readTextFile } from '../../platform/domain/jsonFile.js';
import {
  AccountNotFoundError,
  CcswapError,
  ConfigError,
  ValidationError,
} from '../../platform/domain/errors.js';
import { nextFreeSlot, normalizeAlias } from '../../platform/domain/identifiers.js';
import { backupRoot, claudeConfigHome } from '../../platform/domain/paths.js';
import type { ClaudeSequence } from '../domain/sequence.js';
import { claudeSequenceSchema } from '../domain/sequence.js';
import { loadClaudeUsage } from '../../usage/application/readUsage.js';
import {
  moveMutation,
  removeMutation,
  setAliasMutation,
  setDisabledMutation,
  swapMutation,
  unsetAliasMutation,
} from '../domain/mutations.js';
import { liveIdentity } from '../adapters/liveIdentity.js';
import {
  backupConfigPath,
  backupCredentialPath,
  clearSlotBackups,
  encodeBackupCredentials,
  liveCredentialsPath,
  looksLikeApiKey,
  readBackupCredentials,
  readLiveCapture,
  readSlotMaterial,
  swapSlotMaterials,
  writeSlotMaterial,
} from '../adapters/liveCredentials.js';
import { loadClaudeRoster } from '../adapters/roster.js';
import { reverseUnlink, updateClaudeSequence } from '../adapters/rosterStore.js';

export interface UseCaseResult {
  code: number;
  message: string;
  payload?: Record<string, unknown> | undefined;
  reverse: ReverseLog;
  /** False → the caller must fall back to the Python CLI for this argv. */
  handled: boolean;
  fallbackReason?: string;
}

export function ok(message: string, payload?: Record<string, unknown>, reverse?: ReverseLog): UseCaseResult {
  return { code: 0, message, payload, reverse: reverse ?? new ReverseLog(), handled: true };
}

export function unhandled(reason: string): UseCaseResult {
  return {
    code: 1,
    message: reason,
    reverse: new ReverseLog(),
    handled: false,
    fallbackReason: reason,
  };
}

export function failed(err: unknown): UseCaseResult {
  if (err instanceof CcswapError) {
    return { code: err.exitCode, message: err.message, reverse: new ReverseLog(), handled: true };
  }
  return {
    code: 1,
    message: err instanceof Error ? err.message : String(err),
    reverse: new ReverseLog(),
    handled: true,
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function sessionShellGuard(): void {
  // Python parity: mutating commands refuse inside a session-mode shell.
  if (process.env['CCSWAP_SESSION'] === '1' || process.env['CCSWAP_SESSION_SHELL'] === '1') {
    throw new ConfigError('Refusing: this command cannot run inside a session-mode shell');
  }
}

// ---- alias ---------------------------------------------------------------

export function aliasSet(root: string, identifier: string, alias: string): UseCaseResult {
  try {
    sessionShellGuard();
    const reverse = new ReverseLog();
    const normalized = normalizeAlias(alias);
    const out = updateClaudeSequence(root, reverse, (seq) => {
      const r = setAliasMutation(seq, identifier, normalized, nowIso());
      return { seq: r.doc, changed: [slotOf(seq, identifier)], note: r.detail };
    });
    return ok(out.note, undefined, reverse);
  } catch (err) {
    return failed(err);
  }
}

export function aliasUnset(root: string, identifier: string): UseCaseResult {
  try {
    sessionShellGuard();
    const reverse = new ReverseLog();
    const out = updateClaudeSequence(root, reverse, (seq) => {
      const r = unsetAliasMutation(seq, identifier, nowIso());
      return { seq: r.doc, changed: [slotOf(seq, identifier)], note: r.detail };
    });
    return ok(out.note, undefined, reverse);
  } catch (err) {
    return failed(err);
  }
}

function slotOf(seq: ClaudeSequence, identifier: string): string {
  try {
    const id = identifier.trim();
    if (/^\d+$/.test(id)) return String(Number(id));
    for (const [slot, rec] of Object.entries(seq.accounts)) {
      if (rec.alias === id.toLowerCase() || rec.email === id) return slot;
    }
  } catch {
    // Best effort for the changed-set only.
  }
  return identifier;
}

// ---- remove / disable / enable --------------------------------------------

export function removeAccount(root: string, identifier: string, assumeYes: boolean): UseCaseResult {
  try {
    sessionShellGuard();
    if (!assumeYes) {
      return unhandled('remove without --yes needs an interactive confirmation prompt');
    }
    const reverse = new ReverseLog();
    let removed = { email: '', organizationUuid: '', wasActive: false, slot: '' };
    const out = updateClaudeSequence(root, reverse, (seq) => {
      const r = removeMutation(seq, identifier, nowIso());
      const slot = slotOf(seq, identifier);
      removed = { email: r.email, organizationUuid: r.organizationUuid, wasActive: r.wasActive, slot };
      return { seq: r.doc, changed: [slot], note: `Removed Account-${slot} (${r.email})` };
    });
    // Delete per-slot backup files (credentials + config), recorded in reverse.
    reverseUnlink(root, reverse, backupCredentialPath(root, removed.slot, removed.email));
    reverseUnlink(root, reverse, backupConfigPath(root, removed.slot, removed.email));
    pruneMapping(root, reverse, removed.email, removed.organizationUuid);
    return ok(out.note, undefined, reverse);
  } catch (err) {
    if (err instanceof ValidationError && /Multiple accounts/.test(err.message)) {
      return unhandled('ambiguous email needs the interactive slot prompt');
    }
    return failed(err);
  }
}

export function pruneMapping(root: string, reverse: ReverseLog, email: string, orgUuid: string): number {
  const file = path.join(root, 'mappings.json');
  let doc: { mappings?: Record<string, { email?: string; organizationUuid?: string }> };
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf-8')) as typeof doc;
  } catch {
    return 0;
  }
  const mappings = doc.mappings;
  if (!mappings || typeof mappings !== 'object') return 0;
  const prunedKeys = Object.entries(mappings)
    .filter(([, entry]) => entry.email === email && (entry.organizationUuid ?? '') === orgUuid)
    .map(([dir]) => dir);
  if (prunedKeys.length === 0) return 0;
  const kept: typeof mappings = {};
  for (const [dir, entry] of Object.entries(mappings)) {
    if (!prunedKeys.includes(dir)) kept[dir] = entry;
  }
  reverse.record(file);
  fs.writeFileSync(file, `${JSON.stringify({ ...doc, mappings: kept }, null, 2)}\n`);
  return prunedKeys.length;
}

export function disableAccount(root: string, identifier: string): UseCaseResult {
  try {
    sessionShellGuard();
    const reverse = new ReverseLog();
    const out = updateClaudeSequence(root, reverse, (seq) => {
      const r = setDisabledMutation(seq, identifier, true, nowIso());
      return { seq: r.doc, changed: [slotOf(seq, identifier)], note: r.detail };
    });
    return ok(out.note, undefined, reverse);
  } catch (err) {
    return failed(err);
  }
}

export function enableAccount(root: string, identifier: string): UseCaseResult {
  try {
    sessionShellGuard();
    const reverse = new ReverseLog();
    const out = updateClaudeSequence(root, reverse, (seq) => {
      const r = setDisabledMutation(seq, identifier, false, nowIso());
      return { seq: r.doc, changed: [slotOf(seq, identifier)], note: r.detail };
    });
    return ok(out.note, undefined, reverse);
  } catch (err) {
    return failed(err);
  }
}

// ---- swap / move ------------------------------------------------------------

export function swapAccounts(root: string, first: string, second: string): UseCaseResult {
  try {
    sessionShellGuard();
    if (hasLiveSessionProfile(root)) {
      return unhandled('session-mode profile present; Python owns the adoption/refusal dance');
    }
    const reverse = new ReverseLog();
    const out = updateClaudeSequence(root, reverse, (seq) => {
      const r = swapMutation(seq, first, second, nowIso());
      // Cross-write the file backups so credentials follow the account
      // (Python swap parity); every path is reverse-recorded first.
      // Keychain entries and session dirs stay in Python (see module header).
      const emailA = seq.accounts[r.slotA]?.email ?? '';
      const emailB = seq.accounts[r.slotB]?.email ?? '';
      const matA = readSlotMaterial(root, r.slotA, emailA);
      const matB = readSlotMaterial(root, r.slotB, emailB);
      swapSlotMaterials(root, reverse, r.slotA, emailA, matA, r.slotB, emailB, matB);
      return { seq: r.doc, changed: [r.slotA, r.slotB], note: r.detail };
    });
    return ok(out.note, undefined, reverse);
  } catch (err) {
    return failed(err);
  }
}

export function moveAccount(root: string, identifier: string, target: string): UseCaseResult {
  try {
    sessionShellGuard();
    if (hasLiveSessionProfile(root)) {
      return unhandled('session-mode profile present; Python owns the adoption/refusal dance');
    }
    const reverse = new ReverseLog();
    const out = updateClaudeSequence(root, reverse, (seq) => {
      const r = moveMutation(seq, identifier, target, nowIso());
      const targetSlot = String(r.target);
      if (r.swapped) {
        // Occupied target: the same cross-write as a swap.
        const emailA = seq.accounts[r.slot]?.email ?? '';
        const emailB = seq.accounts[targetSlot]?.email ?? '';
        const matA = readSlotMaterial(root, r.slot, emailA);
        const matB = readSlotMaterial(root, targetSlot, emailB);
        swapSlotMaterials(root, reverse, r.slot, emailA, matA, targetSlot, emailB, matB);
      } else if (r.slot !== targetSlot) {
        // Empty target: relocate the material, then clear the stale key
        // (Python move parity: write-or-actively-clear, old key cleared).
        const email = seq.accounts[r.slot]?.email ?? '';
        const mat = readSlotMaterial(root, r.slot, email);
        writeSlotMaterial(root, reverse, targetSlot, email, mat);
        clearSlotBackups(root, reverse, r.slot, email);
      }
      return { seq: r.doc, changed: [r.slot, targetSlot], note: r.detail };
    });
    return ok(out.note, undefined, reverse);
  } catch (err) {
    return failed(err);
  }
}

function hasLiveSessionProfile(root: string): boolean {
  // Any session profile directory with live records → Python decides.
  const dir = path.join(root, 'sessions');
  try {
    const entries = fs.readdirSync(dir);
    return entries.length > 0;
  } catch {
    return false;
  }
}

// ---- switch ------------------------------------------------------------------

export interface SwitchOptions {
  strategy?: 'best' | 'next-available' | 'consume-first' | undefined;
  json?: boolean;
  force?: boolean;
}

interface RankedSlot {
  slot: string;
  email: string;
}

function rankByCachedUsage(root: string, strategy: string): RankedSlot[] {
  const rows = loadClaudeUsage(root);
  const headroom = rows.map((r) => {
    const lastGood = (r.lastGood ?? {}) as {
      windows?: Array<{ usedPercent?: number | null; resetsAt?: number | null }>;
    };
    const windows = Array.isArray(lastGood.windows) ? lastGood.windows : [];
    const worst = windows.reduce<number>(
      (m, w) => Math.max(m, typeof w.usedPercent === 'number' ? w.usedPercent : 0),
      0,
    );
    const soonestReset = windows.reduce<number | null>((m, w) => {
      if (typeof w.resetsAt !== 'number') return m;
      return m === null ? w.resetsAt : Math.min(m, w.resetsAt);
    }, null);
    return { slot: r.slot, email: r.email, worst, soonestReset };
  });
  const usable = headroom.filter((r) => r.worst < 100);
  if (strategy === 'next-available') {
    return usable.sort((a, b) => Number(a.slot) - Number(b.slot));
  }
  if (strategy === 'consume-first') {
    return usable.sort((a, b) => (a.soonestReset ?? Infinity) - (b.soonestReset ?? Infinity));
  }
  return usable.sort((a, b) => a.worst - b.worst || Number(a.slot) - Number(b.slot));
}

export function switchAccount(
  root: string,
  identifier: string | null,
  opts: SwitchOptions = {},
): UseCaseResult {
  try {
    sessionShellGuard();
    if (hasLiveSessionProfile(root)) {
      return unhandled('session-mode profile present; Python owns the adoption/refusal dance');
    }
    const configHome = claudeConfigHome();
    const reverse = new ReverseLog();
    let target = identifier;
    if (target === null) {
      if (!opts.strategy) {
        return {
          code: 2,
          message: 'switch needs an account or --strategy',
          reverse,
          handled: true,
        };
      }
      const ranked = rankByCachedUsage(root, opts.strategy);
      if (ranked.length === 0) {
        return unhandled('no cached usage rows; Python performs the live ranking refresh');
      }
      // next-available rotates past the active slot; others take the head.
      if (opts.strategy === 'next-available') {
        const live = liveIdentity();
        const activeIdx = ranked.findIndex(
          (r) => live !== null && matchLiveSlot(root, live.email, live.organizationUuid) === r.slot,
        );
        target = ranked[(activeIdx + 1) % ranked.length]?.slot ?? null;
      } else {
        target = ranked[0]?.slot ?? null;
      }
      if (target === null) return unhandled('strategy found no usable account');
    }
    return performFileSwitch(root, configHome, target, opts, reverse);
  } catch (err) {
    if (err instanceof ValidationError && /Multiple accounts/.test(err.message)) {
      return unhandled('ambiguous email needs the interactive slot prompt');
    }
    return failed(err);
  }
}

function matchLiveSlot(root: string, email: string, orgUuid: string): string | null {
  try {
    const { sequence } = loadClaudeRoster(root);
    for (const [slot, rec] of Object.entries(sequence.accounts)) {
      if (rec.email === email && rec.organizationUuid === orgUuid) return slot;
    }
  } catch {
    // No live match determinable.
  }
  return null;
}

function performFileSwitch(
  root: string,
  configHome: string,
  identifier: string,
  opts: SwitchOptions,
  reverse: ReverseLog,
): UseCaseResult {
  const { sequence } = loadClaudeRoster(root);
  const id = identifier.trim();
  let target: string | null = null;
  if (/^\d+$/.test(id)) {
    const s = String(Number(id));
    target = sequence.accounts[s] !== undefined ? s : null;
  } else {
    const lowered = id.toLowerCase();
    for (const [slot, rec] of Object.entries(sequence.accounts)) {
      if (rec.alias !== undefined && rec.alias.toLowerCase() === lowered) {
        target = slot;
        break;
      }
    }
    if (target === null) {
      const hits = Object.entries(sequence.accounts)
        .filter(([, rec]) => rec.email === id)
        .map(([slot]) => slot);
      if (hits.length === 1) target = hits[0] as string;
      else if (hits.length > 1) {
        throw new ValidationError(`Multiple accounts found for '${identifier}': ${hits.join(', ')}`);
      }
    }
  }
  if (target === null) throw new AccountNotFoundError(`No account found with identifier: ${identifier}`);
  const slot = target;
  const record = sequence.accounts[slot];
  if (!record) throw new AccountNotFoundError(`Account-${slot} does not exist`);
  if (record.disabled && !opts.force) {
    throw new ConfigError(`Account-${slot} is disabled; enable it first`);
  }
  // The stored backup must be file-readable; keychain-only → Python.
  const backupCreds = readBackupCredentials(backupCredentialPath(root, slot, record.email));
  if (backupCreds === null) {
    return unhandled(`Account-${slot} backup is keychain-only; Python performs the switch`);
  }
  const backupConfig = readBackupConfigText(root, slot, record.email);
  if (backupConfig === null) {
    throw new ConfigError(`Account-${slot} has no stored config backup`);
  }
  // No-op guard (Python issue #79 parity): already on the target and the
  // live credential matches the backup → no mutation, no lock.
  const live = liveIdentity();
  const liveSlot = live !== null ? matchLiveSlot(root, live.email, live.organizationUuid) : null;
  const liveCreds = readLiveCredsText(configHome);
  if (!opts.force && liveSlot === slot && liveCreds !== null && liveCreds === backupCreds) {
    const ref = `${slot} (${record.email})`;
    if (opts.json) {
      return ok(
        `Already on Account-${slot} (${record.email})`,
        {
          schemaVersion: 1,
          strategy: 'direct',
          from: ref,
          to: ref,
          noop: true,
          reason: 'already-active',
        },
        reverse,
      );
    }
    return ok(`Already on Account-${slot} (${record.email})`, undefined, reverse);
  }
  // Commit under the roster lock: back up the displaced live login into
  // its managed slot (unless --force), then activate the target.
  const result = withFileLock(root, () => {
    const raw = readSeqJson(root);
    const seq = raw.seq;
    const fromSlot = live !== null ? matchLiveSlot(root, live.email, live.organizationUuid) : null;
    if (!opts.force && liveCreds !== null && fromSlot !== null && fromSlot !== slot) {
      const fromRec = seq.accounts[fromSlot];
      if (fromRec) {
        reverse.record(backupCredentialPath(root, fromSlot, fromRec.email));
        writeEnc(root, fromSlot, fromRec.email, liveCreds);
      }
    }
    const liveCredPath = liveCredentialsPath(configHome);
    reverse.record(liveCredPath);
    writeText(liveCredPath, backupCreds);
    const globalPath = globalConfigPath(configHome);
    reverse.record(globalPath);
    writeText(globalPath, backupConfig);
    reverse.record(seqFile(root));
    const next: ClaudeSequence = {
      ...seq,
      activeAccountNumber: Number(slot),
      lastUpdated: nowIso(),
    };
    writeSeqJson(root, next);
    return { fromSlot, accounts: next.accounts };
  });
  void result;
  return ok(
    `Switched to Account-${slot} (${record.email})`,
    {
      schemaVersion: 1,
      strategy: opts.strategy ?? 'direct',
      from: result.fromSlot,
      to: slot,
    },
    reverse,
  );
}

function readBackupConfigText(root: string, slot: string, email: string): string | null {
  return readTextFile(backupConfigPath(root, slot, email));
}

function readLiveCredsText(configHome: string): string | null {
  return readTextFile(liveCredentialsPath(configHome));
}

function globalConfigPath(configHome: string): string {
  const legacy = path.join(configHome, '.config.json');
  try {
    const st = fs.statSync(legacy);
    if (st.isFile() && st.size > 0) return legacy;
  } catch {
    // Fall through.
  }
  return path.join(process.env['HOME'] ?? '', '.claude.json');
}

function writeEnc(root: string, slot: string, email: string, credentials: string): void {
  const file = backupCredentialPath(root, slot, email);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${String(process.pid)}`;
  fs.writeFileSync(tmp, encodeBackupCredentials(credentials));
  fs.renameSync(tmp, file);
}

function seqFile(root: string): string {
  return path.join(root, 'sequence.json');
}

function readSeqJson(root: string): { seq: ClaudeSequence } {
  const raw = readJsonFile(seqFile(root));
  if (raw === null) throw new ConfigError('No accounts are managed yet');
  return { seq: claudeSequenceSchema.parse(raw) as ClaudeSequence };
}

function writeSeqJson(root: string, seq: ClaudeSequence): void {
  const file = seqFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${String(process.pid)}`;
  fs.writeFileSync(tmp, `${JSON.stringify(seq, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function writeText(filePath: string, text: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${String(process.pid)}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, filePath);
}

// ---- add / add-token ------------------------------------------------------------

const EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

function validateEmail(email: string): void {
  if (!EMAIL_RE.test(email)) throw new ValidationError(`Invalid email format: ${email}`);
}

export interface AddOptions {
  slot?: number | undefined;
  alias?: string | undefined;
  assumeYes?: boolean;
}

/** Register the live login as a managed account (browser login done beforehand). */
export function addAccount(root: string, opts: AddOptions = {}): UseCaseResult {
  try {
    sessionShellGuard();
    if (opts.alias !== undefined) normalizeAlias(opts.alias);
    const capture = readLiveCapture(root);
    if (capture.needsFallback) {
      return unhandled(`live login is keychain-only: ${capture.reason ?? 'unreadable'}`);
    }
    const live = capture.capture;
    if (live === null) {
      const reason = capture.reason ?? 'no-live-login';
      if (reason === 'live-login-is-api-key') {
        throw new ValidationError('The live login is a managed API key; use add-token for API keys');
      }
      throw new ConfigError('No active Claude account found. Please log in first.');
    }
    validateEmail(live.email);
    const reverse = new ReverseLog();
    const out = updateClaudeSequence(root, reverse, (seq) => {
      const existing = findSlot(seq, live.email, live.organizationUuid);
      if (opts.slot === undefined && existing !== null) {
        // Refresh credentials in place (Python parity).
        const num = existing;
        reverse.record(backupCredentialPath(root, num, live.email));
        writeEnc(root, num, live.email, live.credentials);
        reverse.record(backupConfigPath(root, num, live.email));
        writeText(backupConfigPath(root, num, live.email), live.configText);
        const next: ClaudeSequence = {
          ...seq,
          accounts:
            opts.alias !== undefined
              ? {
                  ...seq.accounts,
                  [num]: { ...(seq.accounts[num] as ClaudeRecord), alias: normalizeAlias(opts.alias) },
                }
              : { ...seq.accounts },
          activeAccountNumber: Number(num),
          lastUpdated: nowIso(),
        };
        return { seq: next, changed: [num], note: `Refreshed Account-${num} (${live.email})` };
      }
      let slotStr: string;
      if (opts.slot !== undefined) {
        if (opts.slot < 1) throw new ConfigError('Slot number must be >= 1');
        slotStr = String(opts.slot);
        if (seq.accounts[slotStr] !== undefined && !opts.assumeYes) {
          throw new OverwriteNeeded(slotStr);
        }
      } else {
        slotStr = String(nextFreeSlot(new Set(Object.keys(seq.accounts).map(Number))));
      }
      if (opts.alias !== undefined) {
        for (const [other, rec] of Object.entries(seq.accounts)) {
          if (other !== slotStr && rec.alias === normalizeAlias(opts.alias)) {
            throw new ConfigError(
              `Alias '${normalizeAlias(opts.alias)}' is already used by account ${other}`,
            );
          }
        }
      }
      const prev: ClaudeRecord | undefined = seq.accounts[slotStr];
      reverse.record(backupCredentialPath(root, slotStr, live.email));
      writeEnc(root, slotStr, live.email, live.credentials);
      reverse.record(backupConfigPath(root, slotStr, live.email));
      writeText(backupConfigPath(root, slotStr, live.email), live.configText);
      const next: ClaudeSequence = {
        ...seq,
        accounts: {
          ...seq.accounts,
          [slotStr]: {
            email: live.email,
            uuid: live.accountUuid,
            organizationUuid: live.organizationUuid,
            organizationName: prev?.organizationName ?? '',
            added: prev?.added ?? nowIso(),
            ...(opts.alias !== undefined
              ? { alias: normalizeAlias(opts.alias) }
              : prev?.alias !== undefined
                ? { alias: prev.alias }
                : {}),
            disabled: false,
          },
        },
        sequence: seq.sequence.includes(Number(slotStr))
          ? [...seq.sequence]
          : [...seq.sequence, Number(slotStr)].sort((a, b) => a - b),
        activeAccountNumber: Number(slotStr),
        lastUpdated: nowIso(),
      };
      return { seq: next, changed: [slotStr], note: `Added Account-${slotStr} (${live.email})` };
    });
    return ok(out.note, undefined, reverse);
  } catch (err) {
    if (err instanceof OverwriteNeeded) {
      return unhandled(`slot ${err.slot} is occupied; confirmation prompt needed`);
    }
    return failed(err);
  }
}

class OverwriteNeeded extends CcswapError {
  readonly slot: string;
  constructor(slot: string) {
    super(`slot occupied: ${slot}`, 1);
    this.slot = slot;
  }
}

type ClaudeRecord = ClaudeSequence['accounts'][string];

function findSlot(seq: ClaudeSequence, email: string, orgUuid: string): string | null {
  for (const [slot, rec] of Object.entries(seq.accounts)) {
    if (rec.email === email && rec.organizationUuid === orgUuid) return slot;
  }
  return null;
}

export interface AddTokenOptions {
  email?: string | undefined;
  slot?: number | undefined;
  assumeYes?: boolean;
}

/** Register a raw OAuth setup-token or managed API key (no network calls). */
export function addToken(root: string, token: string, opts: AddTokenOptions = {}): UseCaseResult {
  try {
    sessionShellGuard();
    const clean = token.trim();
    if (clean === '') throw new ValidationError('Token cannot be empty');
    const { looksLikeApiKey: isKey } = staticTokenKind;
    const isApiKey = isKey(clean);
    if (opts.email !== undefined) validateEmail(opts.email);
    const reverse = new ReverseLog();
    const out = updateClaudeSequence(root, reverse, (seq) => {
      let slot = opts.slot !== undefined ? opts.slot : null;
      let email = opts.email ?? '';
      if (slot !== null && slot < 1) throw new ConfigError('Slot number must be >= 1');
      if (!email) {
        const n = slot ?? nextFreeSlot(new Set(Object.keys(seq.accounts).map(Number)));
        email = `${isApiKey ? 'api-key' : 'setup-token'}-${String(n)}@token.local`;
        if (slot === null) slot = n;
      }
      if (slot === null) slot = nextFreeSlot(new Set(Object.keys(seq.accounts).map(Number)));
      // Cross-kind collision guard (Python parity): an api-key and an OAuth
      // account sharing an email are indistinguishable at switch time.
      const slotStr = String(slot);
      const prevSlot: ClaudeRecord | undefined = seq.accounts[slotStr];
      const existingSameEmail = findSlot(seq, email, '');
      if (existingSameEmail !== null && existingSameEmail !== slotStr) {
        const sameKind = isKey(
          readBackupCredentials(backupCredentialPath(root, existingSameEmail, email)) ?? '',
        );
        if (sameKind !== isApiKey) {
          throw new ValidationError(
            `An account for ${email} of the other kind already exists (slot ${existingSameEmail})`,
          );
        }
      }
      if (seq.accounts[slotStr] !== undefined && !opts.assumeYes) {
        const occupant = seq.accounts[slotStr];
        if (occupant.email !== email) throw new OverwriteNeeded(slotStr);
      }
      const credentials = isApiKey
        ? clean
        : JSON.stringify({ claudeAiOauth: { accessToken: clean, scopes: ['user:inference'] } });
      const config = JSON.stringify({
        oauthAccount: {
          emailAddress: email,
          accountUuid: '',
          organizationUuid: null,
          organizationName: null,
        },
      });
      reverse.record(backupCredentialPath(root, slotStr, email));
      writeEnc(root, slotStr, isApiKey ? email : email, credentials);
      reverse.record(backupConfigPath(root, slotStr, email));
      writeText(backupConfigPath(root, slotStr, email), config);
      const next: ClaudeSequence = {
        ...seq,
        accounts: {
          ...seq.accounts,
          [slotStr]: {
            email,
            uuid: '',
            organizationUuid: '',
            organizationName: '',
            added: prevSlot?.added ?? nowIso(),
            ...(prevSlot?.alias !== undefined ? { alias: prevSlot.alias } : {}),
            disabled: false,
          },
        },
        sequence: seq.sequence.includes(slot)
          ? [...seq.sequence]
          : [...seq.sequence, slot].sort((a, b) => a - b),
        activeAccountNumber: Number(slotStr),
        lastUpdated: nowIso(),
      };
      const kind = isApiKey ? 'API key' : 'token';
      return { seq: next, changed: [slotStr], note: `Added ${kind} for Account-${slotStr} (${email})` };
    });
    return ok(out.note, undefined, reverse);
  } catch (err) {
    if (err instanceof OverwriteNeeded) {
      return unhandled(`slot ${err.slot} is occupied; confirmation prompt needed`);
    }
    return failed(err);
  }
}

const staticTokenKind = { looksLikeApiKey };
void backupRoot;
