/**
 * Application: codex add/remove/switch/status bookkeeping (file-backed core).
 * Session custody, generation conflicts, `run` exec, `auto` polling, and
 * `redeem-reset` stay in Python (`handled: false` with the reason).
 */

import fs from 'node:fs';
import { ReverseLog } from '../../platform/domain/atomicFile.js';
import { ConfigError, ValidationError } from '../../platform/domain/errors.js';
import { nextFreeSlot } from '../../platform/domain/identifiers.js';
import { backupRoot } from '../../platform/domain/paths.js';
import { failed, ok, unhandled, type UseCaseResult } from '../../accounts/application/manageAccounts.js';
import { codexIdentity, parseCodexAuth } from '../domain/codexRoster.js';
import {
  codexBackupAuthPath,
  codexLiveAuthPath,
  codexSlotHasSessions,
  readCodexSequence,
  readLiveCodexAuth,
  updateCodex,
} from '../adapters/codexStore.js';

function nowStamp(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z');
}

function resolveCodexSlot(seq: ReturnType<typeof readCodexSequence>, identifier: string): string {
  const id = identifier.trim();
  if (/^\d+$/.test(id)) {
    const s = String(Number(id));
    if (seq.accounts[s] !== undefined) return s;
    throw new ConfigError(`No Codex account found with identifier: ${identifier}`);
  }
  const lowered = id.toLowerCase();
  for (const [slot, rec] of Object.entries(seq.accounts)) {
    if (rec.alias !== undefined && rec.alias.toLowerCase() === lowered) return slot;
  }
  const hits = Object.entries(seq.accounts)
    .filter(([, rec]) => rec.email === id)
    .map(([slot]) => slot);
  if (hits.length === 1) return hits[0] as string;
  if (hits.length > 1) throw new ValidationError(`Multiple Codex accounts found for '${identifier}'`);
  throw new ConfigError(`No Codex account found with identifier: ${identifier}`);
}

export function codexAdd(root: string = backupRoot(), slot?: number, assumeYes = false): UseCaseResult {
  try {
    const liveText = readLiveCodexAuth();
    if (!liveText) throw new ConfigError("No Codex login found; run 'codex login' first");
    let live: unknown;
    try {
      live = JSON.parse(liveText) as unknown;
    } catch {
      throw new ConfigError('Codex auth.json is not valid JSON');
    }
    const auth = parseCodexAuth(live);
    if (!auth) throw new ConfigError('Codex auth.json is unreadable');
    const { email, accountId, mode } = codexIdentity(auth);
    if (!email) throw new ValidationError('Codex auth.json does not contain a usable account identity');
    if (codexSlotHasSessions(root, '*')) {
      return unhandled('Codex session profiles exist; Python owns the custody check');
    }
    const reverse = new ReverseLog();
    const detail = updateCodex(root, reverse, (seq) => {
      const existing = Object.entries(seq.accounts).find(([, rec]) => rec.email === email)?.[0] ?? null;
      let number: string;
      if (slot !== undefined) {
        if (slot < 1) throw new ValidationError('Codex account slot must be a positive integer');
        number = String(slot);
      } else {
        number = existing ?? String(nextFreeSlot(new Set(Object.keys(seq.accounts).map(Number))));
      }
      const occupant = seq.accounts[number];
      if (occupant && number !== existing && !assumeYes) {
        return { seq, result: `OVERWRITE_PROMPT:${number}` };
      }
      if (codexSlotHasSessions(root, number)) {
        throw new ConfigError(`Codex session home kept for slot ${number}; manual disposition required`);
      }
      if (readLiveCodexAuth() !== liveText) {
        throw new ConfigError('Codex login changed; retry');
      }
      reverse.record(codexBackupAuthPath(root, number));
      fs.writeFileSync(codexBackupAuthPath(root, number), `${JSON.stringify(live, null, 2)}\n`);
      const next = {
        ...seq,
        accounts: {
          ...seq.accounts,
          [number]: {
            email,
            alias: occupant?.alias,
            disabled: false,
            accountId,
            authMode: mode,
            added: occupant !== undefined ? nowStamp() : nowStamp(),
          },
        },
        sequence: seq.sequence.includes(Number(number))
          ? [...seq.sequence]
          : [...seq.sequence, Number(number)].sort((a, b) => a - b),
        activeAccountNumber: Number(number),
      };
      return { seq: next, result: `Added Codex Account ${number}: ${email}` };
    });
    if (detail.startsWith('OVERWRITE_PROMPT:')) {
      return unhandled(
        `slot ${detail.slice('OVERWRITE_PROMPT:'.length)} is occupied; confirmation prompt needed`,
      );
    }
    return ok(detail, undefined, reverse);
  } catch (err) {
    return failed(err);
  }
}

export function codexRemove(
  root: string = backupRoot(),
  identifier: string,
  assumeYes = false,
): UseCaseResult {
  try {
    if (!assumeYes) return unhandled('codex remove without --yes needs a confirmation prompt');
    const reverse = new ReverseLog();
    const detail = updateCodex(root, reverse, (seq) => {
      const number = resolveCodexSlot(seq, identifier);
      if (codexSlotHasSessions(root, number)) {
        throw new ConfigError(`Codex session custody for slot ${number}; retry in Python`);
      }
      const rec = seq.accounts[number];
      const { [number]: _removedCodex, ...kept } = seq.accounts;
      void _removedCodex;
      const next = { ...seq, accounts: kept };
      if (next.activeAccountNumber === Number(number)) next.activeAccountNumber = null;
      reverse.record(codexBackupAuthPath(root, number));
      try {
        fs.unlinkSync(codexBackupAuthPath(root, number));
      } catch {
        // Absent backup is fine.
      }
      return { seq: next, result: `Removed Codex Account ${number} (${rec?.email ?? '?'})` };
    });
    return ok(detail, undefined, reverse);
  } catch (err) {
    return failed(err);
  }
}

export function codexSwitch(
  root: string = backupRoot(),
  identifier: string | null,
  opts: { json?: boolean | undefined; strategy?: string | undefined; force?: boolean | undefined } = {},
): UseCaseResult {
  try {
    const seq = readCodexSequence(root);
    void seq;
    if (identifier === null && opts.strategy) {
      return unhandled('bare codex switch --strategy ranks live quota in Python');
    }
    if (identifier === null) {
      return {
        code: 2,
        message: 'codex switch needs an account or --strategy',
        reverse: new ReverseLog(),
        handled: true,
      };
    }
    // Session-custody recheck lives in Python; refuse when markers exist.
    const reverse = new ReverseLog();
    const detail = updateCodex(root, reverse, (locked) => {
      const number = resolveCodexSlot(locked, identifier);
      if (codexSlotHasSessions(root, number)) {
        throw new ConfigError(`Codex session custody for slot ${number}; retry in Python`);
      }
      let stored: string;
      try {
        stored = fs.readFileSync(codexBackupAuthPath(root, number), 'utf-8');
      } catch {
        throw new ConfigError('stored Codex auth.json is missing');
      }
      const livePath = codexLiveAuthPath();
      reverse.record(livePath);
      fs.writeFileSync(livePath, stored);
      const next = { ...locked, activeAccountNumber: Number(number) };
      return { seq: next, result: `Switched Codex to Account ${number}` };
    });
    return ok(detail, { schemaVersion: 1, provider: 'codex' }, reverse);
  } catch (err) {
    if (err instanceof ConfigError && /custody|retry in Python/.test(err.message)) {
      return unhandled(err.message);
    }
    return failed(err);
  }
}
