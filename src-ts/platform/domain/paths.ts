/** Backup-root resolution. Mirrors `claude_swap/paths.py`. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function homeDir(): string {
  return process.env['HOME'] ?? os.homedir();
}

/**
 * Test/embedding hook: when set, this exact directory is the backup root.
 * Production never sets it; it exists so fixtures can point TS at fake state
 * without touching the real home (Python parity: monkeypatched `Path.home`).
 */
export function backupRoot(): string {
  const override = process.env['CCSWAP_BACKUP_ROOT'];
  if (override !== undefined && override !== '') return override;
  const xdg = process.env['XDG_DATA_HOME'] ?? '';
  if (process.platform === 'linux' && xdg !== '' && path.isAbsolute(xdg)) {
    return path.join(xdg, 'claude-swap');
  }
  return path.join(homeDir(), '.claude-swap-backup');
}

export function claudeConfigHome(): string {
  return process.env['CLAUDE_CONFIG_DIR'] ?? path.join(homeDir(), '.claude');
}

export function claudeGlobalConfigPath(): string {
  const legacy = path.join(claudeConfigHome(), '.config.json');
  const base = process.env['CLAUDE_CONFIG_DIR'] ?? homeDir();
  const globalCfg = path.join(base, '.claude.json');
  // Mirrors `_pick_global_config` (claude-code 2.1.299 rule).
  try {
    const st = fs.statSync(legacy);
    if (st.isFile() && (st.size > 0 || ((st.mode & 0o222) !== 0 && !fs.existsSync(globalCfg)))) {
      return legacy;
    }
  } catch {
    // Missing/unreadable legacy file: the global file wins.
  }
  return globalCfg;
}

export const VENDOR_TOOLS = ['muse', 'kiro'] as const;
export type VendorTool = (typeof VENDOR_TOOLS)[number];

export const ALL_TOOLS = ['claude', 'codex', 'muse', 'kiro', 'agy'] as const;
export type ToolName = (typeof ALL_TOOLS)[number];
