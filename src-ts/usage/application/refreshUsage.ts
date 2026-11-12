/**
 * Application: `usage --refresh` / `usage --check` orchestration.
 * Mirrors the Python per-tool workers: every requested tool is measured on
 * its own path with a 75 s deadline; one hung tool never delays the others,
 * and a failed probe degrades that tool to its cached/last-good row (never
 * fatal for the whole command). `--check` exits 1 when any requested
 * account cannot be shown.
 *
 * Live probes are a `ProbeRunner` interface. This wave ships local
 * single-command probes (single vendor binary, JSON stdout, zod-validated):
 * muse (`muse usage --json`). Tools whose
 * mechanism is interactive or multi-step (claude/codex OAuth, kiro V2
 * harness, agy quota) report `needsProbeFallback`, and the dispatcher falls
 * the whole command through to Python so output stays identical.
 * Fixtures and parity tests inject stub runners — a real vendor CLI is never
 * executed to build fixture state.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ReverseLog } from '../../platform/domain/atomicFile.js';
import { ALL_TOOLS } from '../../platform/domain/paths.js';
import { vendorUsageCacheSchema, type VendorUsageResult } from '../domain/usageCache.js';
import { loadVendorUsage, vendorUsageFor } from './readUsage.js';
import { toolAccounts, loadVendorsDoc } from '../../vendors/adapters/vendorStore.js';
import { failed, ok, type UseCaseResult } from '../../accounts/application/manageAccounts.js';

export const REFRESH_DEADLINE_MS = 75_000;

/** Per-tool probe outcome. `fallback` → Python owns this tool's live probe. */
export interface ProbeOutcome {
  tool: string;
  results: VendorUsageResult[] | null;
  fallback: boolean;
  reason: string;
  elapsedMs: number;
}

export type ProbeRunner = (
  tool: string,
  aliases: string[],
) => Promise<Omit<ProbeOutcome, 'tool' | 'elapsedMs'>>;

const museUsageSchema = z
  .object({
    state: z.string().default('available'),
    windows: z.array(z.unknown()).default([]),
  })
  .catchall(z.unknown());

function withTimeout<T>(promise: Promise<T>, ms: number, tool: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`timed out after ${String(ms)}ms (${tool})`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}

function runBinary(binary: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      args,
      { timeout: timeoutMs, encoding: 'utf-8', maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) reject(err instanceof Error ? err : new Error('probe subprocess failed'));
        else resolve(stdout);
      },
    );
  });
}

/**
 * Local single-command probes. Anything else → `{ fallback: true }` and the
 * dispatcher routes the whole command to Python (output parity).
 */
export async function localProbe(
  tool: string,
  aliases: string[],
): Promise<Omit<ProbeOutcome, 'tool' | 'elapsedMs'>> {
  if (tool === 'muse') {
    try {
      const stdout = await runBinary('muse', ['usage', '--json'], 30_000);
      const parsed = museUsageSchema.parse(JSON.parse(stdout));
      const results: VendorUsageResult[] = aliases.map((alias) => ({
        state: parsed.state,
        reason: '',
        hint: '',
        windows: [],
        observations: [],
        plan: null,
        source: 'muse usage --json',
        authoritative: parsed.state === 'available',
        attributedTo: alias,
        observedAt: Date.now() / 1000,
        error: parsed.state === 'available' ? null : `muse reported ${parsed.state}`,
      }));
      return { results, fallback: false, reason: '' };
    } catch (err) {
      return { results: null, fallback: false, reason: `muse probe failed: ${(err as Error).message}` };
    }
  }
  return { results: null, fallback: true, reason: `${tool} live probe stays in Python this wave` };
}

export interface RefreshOptions {
  check?: boolean;
  persist?: boolean;
  runner?: ProbeRunner;
  deadlineMs?: number;
}

function vendorAliases(root: string, tool: string): string[] {
  const { doc } = loadVendorsDoc(root);
  return toolAccounts(doc, tool).map((a) => a.alias);
}

export async function refreshUsage(
  root: string,
  tools: string[],
  opts: RefreshOptions = {},
): Promise<UseCaseResult> {
  const runner = opts.runner ?? localProbe;
  const deadlineMs = opts.deadlineMs ?? REFRESH_DEADLINE_MS;
  const selected = tools.length > 0 ? tools : [...ALL_TOOLS];
  try {
    for (const t of selected) {
      if (!(ALL_TOOLS as readonly string[]).includes(t)) {
        return { code: 2, message: `Unknown tool: ${t}`, reverse: new ReverseLog(), handled: true };
      }
    }
    const reverse = new ReverseLog();
    const cache = loadVendorUsage(root);
    const started = Date.now();
    const settled = await Promise.all(
      selected.map(async (tool): Promise<ProbeOutcome> => {
        const begin = Date.now();
        try {
          const aliases =
            tool === 'claude' || tool === 'codex' || tool === 'agy'
              ? legacyAliases(root, tool)
              : vendorAliases(root, tool);
          const out = await withTimeout(runner(tool, aliases), deadlineMs, tool);
          return { tool, ...out, elapsedMs: Date.now() - begin };
        } catch (err) {
          return {
            tool,
            results: null,
            fallback: false,
            reason: (err as Error).message,
            elapsedMs: Date.now() - begin,
          };
        }
      }),
    );
    const needsFallback = settled.filter((s) => s.fallback).map((s) => s.tool);
    if (needsFallback.length > 0) {
      return {
        code: 1,
        message: `live probe stays in Python: ${needsFallback.join(', ')}`,
        reverse,
        handled: false,
        fallbackReason: `live probe stays in Python: ${needsFallback.join(', ')}`,
      };
    }
    void started;
    // Persist vendor-tool rows to the usage cache (zod-validated).
    if (opts.persist !== false) {
      const raw = ((): Record<string, unknown> => {
        try {
          return JSON.parse(fs.readFileSync(path.join(root, 'vendors', 'usage.json'), 'utf-8')) as Record<
            string,
            unknown
          >;
        } catch {
          return { schemaVersion: 1, entries: {} };
        }
      })();
      let table: { schemaVersion: number; entries: Record<string, unknown> };
      try {
        table = vendorUsageCacheSchema.parse(raw) as unknown as typeof table;
      } catch {
        table = { schemaVersion: 1, entries: {} };
      }
      for (const s of settled) {
        if (!s.results) continue;
        const aliases =
          s.tool === 'claude' || s.tool === 'codex' || s.tool === 'agy'
            ? legacyAliases(root, s.tool)
            : vendorAliases(root, s.tool);
        s.results.forEach((r, i) => {
          const alias = aliases[i] ?? `account-${String(i + 1)}`;
          table.entries[`${s.tool}\u001f${alias}`] = r;
        });
      }
      const cacheFile = path.join(root, 'vendors', 'usage.json');
      reverse.record(cacheFile);
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(cacheFile, `${JSON.stringify(table, null, 2)}\n`);
    }
    // --check: exit 1 when any requested account cannot be shown.
    const perTool = settled.map((s) => {
      const aliases =
        s.tool === 'claude' || s.tool === 'codex' || s.tool === 'agy'
          ? legacyAliases(root, s.tool)
          : vendorAliases(root, s.tool);
      const accounts = aliases.length > 0 ? aliases : ['(none)'];
      return {
        tool: s.tool,
        liveRefresh: true as const,
        accounts: accounts.map((alias, i) => {
          const live = s.results?.[i] ?? null;
          if (live !== null) return { alias, ...live };
          const cached = vendorUsageFor(cache, s.tool, alias);
          if (cached !== null) return { alias, ...cached, state: 'stale', reason: s.reason };
          return { alias, state: 'error', reason: s.reason || 'no cached reading and live probe failed' };
        }),
      };
    });
    const unshowable = perTool.some((t) =>
      t.accounts.some(
        (a) =>
          (a as { state?: string }).state === 'error' || (a as { state?: string }).state === 'unavailable',
      ),
    );
    const code = opts.check && unshowable ? 1 : 0;
    const res = ok(
      `Refreshed ${selected.join(', ')}`,
      { schemaVersion: 1, liveRefresh: true as const, tools: perTool },
      reverse,
    );
    res.code = code;
    return res;
  } catch (err) {
    return failed(err);
  }
}

function legacyAliases(root: string, tool: string): string[] {
  if (tool === 'claude') {
    return claudeAccountsPayload(root).accounts.map((a) => a.alias ?? a.slot);
  }
  if (tool === 'codex') {
    return codexAccountsPayload(root).accounts.map((a) => a.alias ?? a.slot);
  }
  return agyAccountsPayload(root).accounts.map((a) => a.alias ?? a.slot);
}

import {
  agyAccountsPayload,
  claudeAccountsPayload,
  codexAccountsPayload,
} from '../../accounts/application/listAccounts.js';
