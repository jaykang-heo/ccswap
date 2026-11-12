/**
 * Live Claude credential reads (file-backed only).
 * Mirrors the file half of `claude_swap/credentials.py` capture reads:
 * - live credential file `<claude-config-home>/.credentials.json`
 * - identity triple `(email, orgUuid, accountUuid)` from the global config
 *   `oauthAccount` (same source as `liveIdentity`)
 * - managed API keys (`sk-ant-…` bare strings) are refused for capture
 *   (Python `_reject_live_api_key_capture` parity)
 * - backup blobs `<backup>/credentials/.creds-<slot>-<email>.enc` are
 *   base64 of the credential text (Python `_atomic_b64_write` parity)
 * Keychain-only backups (macOS, no `.enc` file) report `needsFallback`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { atomicWriteFile, type ReverseLog } from '../../platform/domain/atomicFile.js';
import { readJsonFile, readTextFile } from '../../platform/domain/jsonFile.js';
import { backupRoot, claudeConfigHome } from '../../platform/domain/paths.js';
import { liveIdentity } from './liveIdentity.js';

const oauthInner = z
  .object({
    refreshToken: z.string().default(''),
    accessToken: z.string().default(''),
    expiresAt: z.number().default(0),
    scopes: z.array(z.string()).default([]),
  })
  .catchall(z.unknown());

const credentialSchema = z.object({ claudeAiOauth: oauthInner.optional() }).catchall(z.unknown());

export interface LiveCapture {
  credentials: string;
  email: string;
  organizationUuid: string;
  accountUuid: string;
  configText: string;
}

export function looksLikeApiKey(text: string | null): boolean {
  if (!text) return false;
  const t = text.trim();
  if (t.startsWith('{')) return false;
  if (!t.startsWith('sk-ant-')) return false;
  return !t.startsWith('sk-ant-oat');
}

export function liveCredentialsPath(configHome: string = claudeConfigHome()): string {
  return path.join(configHome, '.credentials.json');
}

export function backupCredentialPath(root: string, slot: string, email: string): string {
  return path.join(root, 'credentials', `.creds-${slot}-${email}.enc`);
}

export function backupConfigPath(root: string, slot: string, email: string): string {
  return path.join(root, 'configs', `.claude-config-${slot}-${email}.json`);
}

/** Decode a `.enc` backup blob; null when absent/unreadable. */
export function readBackupCredentials(filePath: string): string | null {
  const text = readTextFile(filePath);
  if (text === null) return null;
  const t = text.trim();
  if (t === '') return null;
  if (t.startsWith('{')) return t; // legacy plaintext backup
  try {
    return Buffer.from(t, 'base64').toString('utf-8');
  } catch {
    return null;
  }
}

export function encodeBackupCredentials(credentials: string): string {
  // Bare base64 text, no trailing newline (Python `_atomic_b64_write` parity).
  return Buffer.from(credentials, 'utf-8').toString('base64');
}

export interface SlotMaterial {
  creds: string;
  config: string;
}

/**
 * A slot key's file backups; missing reads as "" and stays missing after a
 * swap/move (Python `_read_backup_or_abort` missing-material parity). A
 * backup that exists but cannot be read right now (locked macOS Keychain)
 * also reads as "" — that edge stays in Python.
 */
export function readSlotMaterial(root: string, slot: string, email: string): SlotMaterial {
  return {
    creds: readBackupCredentials(backupCredentialPath(root, slot, email)) ?? '',
    config: readTextFile(backupConfigPath(root, slot, email)) ?? '',
  };
}

function writeMaterialFile(reverse: ReverseLog, file: string, text: string, encode: boolean): void {
  reverse.record(file);
  if (text === '') {
    // Required-clear: the new owner must never adopt stale leaked material.
    try {
      fs.unlinkSync(file);
    } catch {
      // Already missing: the required-clear state.
    }
    return;
  }
  atomicWriteFile(file, encode ? encodeBackupCredentials(text) : text);
}

/**
 * Set `(slot, email)`'s file backups to exact material ("" actively clears).
 * Every touched path is reverse-recorded first, so rollback restores bytes.
 */
export function writeSlotMaterial(
  root: string,
  reverse: ReverseLog,
  slot: string,
  email: string,
  material: SlotMaterial,
): void {
  writeMaterialFile(reverse, backupCredentialPath(root, slot, email), material.creds, true);
  writeMaterialFile(reverse, backupConfigPath(root, slot, email), material.config, false);
}

/** Drop a slot key's backup files (post-commit stale-key cleanup). Best effort. */
export function clearSlotBackups(root: string, reverse: ReverseLog, slot: string, email: string): void {
  for (const file of [backupCredentialPath(root, slot, email), backupConfigPath(root, slot, email)]) {
    reverse.record(file);
    try {
      fs.unlinkSync(file);
    } catch {
      // Already gone.
    }
  }
}

/**
 * Cross-write two slots' file backups so credentials follow the account
 * (Python swap parity), then clear the stale keys (post-commit cleanup).
 * Same-email slots share key names, so no stale keys exist to clear.
 */
export function swapSlotMaterials(
  root: string,
  reverse: ReverseLog,
  slotA: string,
  emailA: string,
  matA: SlotMaterial,
  slotB: string,
  emailB: string,
  matB: SlotMaterial,
): void {
  writeSlotMaterial(root, reverse, slotB, emailA, matA);
  writeSlotMaterial(root, reverse, slotA, emailB, matB);
  if (emailA !== emailB) {
    clearSlotBackups(root, reverse, slotA, emailA);
    clearSlotBackups(root, reverse, slotB, emailB);
  }
}

export interface CaptureResult {
  capture: LiveCapture | null;
  /** Set when capture needs the Python CLI (keychain-only live login). */
  needsFallback: boolean;
  reason: string | null;
}

/**
 * Read the live login for capture (add/switch backup-current).
 * File-backed only: a live login that exists solely in the macOS Keychain
 * (no readable `.credentials.json`) reports `needsFallback`.
 */
export function readLiveCapture(
  _root: string = backupRoot(),
  configHome: string = claudeConfigHome(),
): CaptureResult {
  const credText = readTextFile(liveCredentialsPath(configHome));
  if (credText === null || credText.trim() === '') {
    return { capture: null, needsFallback: false, reason: 'no-live-login' };
  }
  if (looksLikeApiKey(credText)) {
    return { capture: null, needsFallback: false, reason: 'live-login-is-api-key' };
  }
  let parsed: z.output<typeof credentialSchema>;
  try {
    parsed = credentialSchema.parse(JSON.parse(credText));
  } catch {
    return { capture: null, needsFallback: false, reason: 'live-credentials-unreadable' };
  }
  if (!parsed.claudeAiOauth) {
    return { capture: null, needsFallback: false, reason: 'live-credentials-unreadable' };
  }
  const identity = liveIdentity();
  if (identity === null) {
    return { capture: null, needsFallback: false, reason: 'no-live-login' };
  }
  const globalConfig = ((): string | null => {
    const candidates = [path.join(configHome, '.config.json'), liveGlobalConfigPath()];
    for (const c of candidates) {
      const t = readTextFile(c);
      if (t !== null) return t;
    }
    return null;
  })();
  if (globalConfig === null) {
    return { capture: null, needsFallback: false, reason: 'live-config-missing' };
  }
  return {
    capture: {
      credentials: credText,
      email: identity.email,
      organizationUuid: identity.organizationUuid,
      accountUuid: readAccountUuid() ?? '',
      configText: globalConfig,
    },
    needsFallback: false,
    reason: null,
  };
}

function liveGlobalConfigPath(): string {
  const legacy = path.join(claudeConfigHome(), '.config.json');
  try {
    const st = fs.statSync(legacy);
    if (st.isFile()) return legacy;
  } catch {
    // Fall through to ~/.claude.json.
  }
  const home = process.env['HOME'] ?? '';
  return path.join(home, '.claude.json');
}

function readAccountUuid(): string | null {
  const raw = readJsonFile(liveGlobalConfigPath());
  if (typeof raw !== 'object' || raw === null) return null;
  const oauth = (raw as Record<string, unknown>)['oauthAccount'];
  if (typeof oauth !== 'object' || oauth === null) return null;
  const uuid = (oauth as Record<string, unknown>)['accountUuid'];
  return typeof uuid === 'string' ? uuid : null;
}
