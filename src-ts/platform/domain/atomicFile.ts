/**
 * Atomic file writes, an inter-process lock, and a reverse path for every
 * state write (strangler requirement: each mutation records how to undo it).
 *
 * - `atomicWriteFile`: write temp + rename; never leaves a torn JSON doc.
 *   Secret files are created 0600 (`<backup>/vendors/secrets/*.secret`).
 * - `withFileLock`: mkdir-based lock on `<root>/.lock` (stale locks older
 *   than 30 s are taken over), mirroring `FileLock` resolve-validate-mutate
 *   spans for switch/usage-refresh (`switcher.py`).
 * - `ReverseLog`: every state write records prior bytes (or absence) plus
 *   mode; `rollback()` restores them in reverse order. Parity tests use it
 *   to prove every mutation has a working reverse path.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export interface ReverseEntry {
  path: string;
  existed: boolean;
  priorBytes: Buffer | null;
  priorMode: number | null;
}

export class ReverseLog {
  private entries: ReverseEntry[] = [];

  record(filePath: string): void {
    let existed = false;
    let priorBytes: Buffer | null = null;
    let priorMode: number | null = null;
    try {
      const st = fs.statSync(filePath);
      if (st.isFile()) {
        existed = true;
        priorMode = st.mode & 0o777;
        priorBytes = fs.readFileSync(filePath);
      }
    } catch {
      existed = false;
    }
    this.entries.push({ path: filePath, existed, priorBytes, priorMode });
  }

  get size(): number {
    return this.entries.length;
  }

  /** Undo every recorded write, newest first. Best-effort; throws on failure. */
  rollback(): void {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i] as ReverseEntry;
      if (!e.existed) {
        try {
          fs.unlinkSync(e.path);
        } catch {
          // Already gone: the reverse end state is what was asked for.
        }
        continue;
      }
      const dir = path.dirname(e.path);
      fs.mkdirSync(dir, { recursive: true });
      const tmp = path.join(dir, `.reverse-${String(process.pid)}-${randomBytes(4).toString('hex')}`);
      fs.writeFileSync(tmp, e.priorBytes as Buffer);
      if (e.priorMode !== null) {
        try {
          fs.chmodSync(tmp, e.priorMode);
        } catch {
          // Non-critical: content restore matters more than mode bits.
        }
      }
      fs.renameSync(tmp, e.path);
    }
    this.entries = [];
  }
}

export function atomicWriteFile(filePath: string, text: string, mode?: number): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.tmp-${String(process.pid)}-${randomBytes(6).toString('hex')}`);
  fs.writeFileSync(tmp, text, { mode: mode ?? 0o644 });
  if (mode !== undefined) {
    try {
      fs.chmodSync(tmp, mode);
    } catch {
      // Best effort (e.g. filesystems that ignore modes).
    }
  }
  fs.renameSync(tmp, filePath);
}

export function atomicWriteJson(filePath: string, value: unknown, mode?: number): void {
  atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`, mode);
}

const LOCK_STALE_MS = 30_000;

function lockDir(root: string): string {
  return path.join(root, '.lock');
}

/** Acquire `<root>/.lock` (mkdir is atomic); stale locks are taken over. */
export function acquireLock(root: string, timeoutMs = 15_000): void {
  const dir = lockDir(root);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      fs.mkdirSync(dir);
      try {
        fs.writeFileSync(path.join(dir, 'pid'), String(process.pid));
      } catch {
        // Informational only.
      }
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err;
      let stale = false;
      try {
        const st = fs.statSync(dir);
        stale = Date.now() - st.mtimeMs > LOCK_STALE_MS;
      } catch {
        stale = true;
      }
      if (stale) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {
          // Lost a race with another taker; retry.
        }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for lock ${dir}`);
      }
      const waitMs = 25;
      const end = Date.now() + waitMs;
      while (Date.now() < end) {
        // Brief cooperative spin; sub-millisecond precision is unnecessary.
      }
    }
  }
}

export function releaseLock(root: string): void {
  try {
    fs.rmSync(lockDir(root), { recursive: true, force: true });
  } catch {
    // Best effort.
  }
}

/** Run `fn` under the backup-root lock (resolve-validate-mutate span). */
export function withFileLock<T>(root: string, fn: () => T): T {
  acquireLock(root);
  try {
    return fn();
  } finally {
    releaseLock(root);
  }
}

/** Backup-root data directory (fake-home safe). */
export function ensureDir(dir: string, mode = 0o700): void {
  fs.mkdirSync(dir, { recursive: true, mode });
  try {
    fs.chmodSync(dir, mode);
  } catch {
    // Best effort.
  }
}

export function tmpHomeEnv(home: string): NodeJS.ProcessEnv {
  return { ...process.env, HOME: home, XDG_DATA_HOME: path.join(home, '.local', 'share') };
}

export function systemTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
