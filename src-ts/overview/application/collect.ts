/**
 * Application: overview collection — the backend the tui/menubar/raycast
 * frontends render. Composes the wave-1 readers (roster payloads, cached
 * usage, vendor probes, settings) into one snapshot; the runtimes
 * (Textual/rumps/JSX) stay in Python/JS, but every backend call they make is
 * ported here. Local reads only — no subprocess, no network, no keychain.
 */

import {
  agyAccountsPayload,
  claudeAccountsPayload,
  claudeActiveSlot,
  codexAccountsPayload,
} from "../../accounts/application/listAccounts.js";
import { liveIdentity } from "../../accounts/adapters/liveIdentity.js";
import { loadVendorsDoc, toolAccounts } from "../../vendors/adapters/vendorStore.js";
import { vendorsPayload } from "../../vendors/application/listVendors.js";
import { loadClaudeUsage, loadVendorUsage, vendorUsageFor } from "../../usage/application/readUsage.js";
import { effectiveSettings } from "../../config/domain/settings.js";
import { readJsonFile } from "../../platform/domain/jsonFile.js";
import { backupRoot } from "../../platform/domain/paths.js";
import path from "node:path";

export interface OverviewTool {
  tool: string;
  accounts: number;
  active: string | null;
  states: Record<string, number>;
}

export interface Overview {
  schemaVersion: 1;
  liveRefresh: false;
  activeEmail: string | null;
  claude: ReturnType<typeof claudeAccountsPayload>;
  codex: ReturnType<typeof codexAccountsPayload>;
  agy: ReturnType<typeof agyAccountsPayload>;
  tools: OverviewTool[];
  vendors: ReturnType<typeof vendorsPayload>;
  settings: ReturnType<typeof effectiveSettings>;
}

/** Worst used-percent across a cached Claude usage row's windows. */
function worstPct(lastGood: unknown): number | null {
  if (typeof lastGood !== "object" || lastGood === null) return null;
  const windows = (lastGood as Record<string, unknown>)["windows"];
  if (!Array.isArray(windows)) return null;
  let worst: number | null = null;
  for (const w of windows) {
    if (typeof w !== "object" || w === null) continue;
    const pct = (w as Record<string, unknown>)["usedPercent"];
    if (typeof pct === "number" && Number.isFinite(pct)) {
      worst = worst === null ? pct : Math.max(worst, pct);
    }
  }
  return worst;
}

export function collectOverview(root: string = backupRoot()): Overview {
  const claude = claudeAccountsPayload(root);
  const codex = codexAccountsPayload(root);
  const agy = agyAccountsPayload(root);
  const { doc } = loadVendorsDoc(root);
  const cache = loadVendorUsage(root);
  const claudeUsage = new Map(loadClaudeUsage(root).map((u) => [u.slot, u]));
  const usageBySlot = new Map<string, unknown>(
    [...claudeUsage.entries()].map(([slot, u]) => [slot, u.lastGood]),
  );

  const tools: OverviewTool[] = [];
  const claudeStates: Record<string, number> = {};
  for (const a of claude.accounts) {
    const state = a.disabled ? "disabled" : a.usageCached ? "cached" : "unknown";
    claudeStates[state] = (claudeStates[state] ?? 0) + 1;
  }
  tools.push({
    tool: "claude",
    accounts: claude.accounts.length,
    active: claudeActiveSlot(root),
    states: claudeStates,
  });
  for (const [tool, payload] of [["codex", codex], ["agy", agy]] as const) {
    const states: Record<string, number> = {};
    for (const a of payload.accounts) {
      const key = a.disabled ? "disabled" : "unknown";
      states[key] = (states[key] ?? 0) + 1;
    }
    tools.push({ tool, accounts: payload.accounts.length, active: payload.active, states });
  }
  for (const tool of ["muse", "kiro"] as const) {
    const states: Record<string, number> = {};
    for (const a of toolAccounts(doc, tool)) {
      const cached = vendorUsageFor(cache, tool, a.alias);
      const key = cached?.state ?? "unknown";
      states[key] = (states[key] ?? 0) + 1;
    }
    tools.push({
      tool,
      accounts: toolAccounts(doc, tool).length,
      active: doc?.tools[tool]?.active ?? null,
      states,
    });
  }

  const settingsRaw = readJsonFile(path.join(root, "settings.json"));
  void usageBySlot;
  void worstPct;
  return {
    schemaVersion: 1,
    liveRefresh: false,
    activeEmail: liveIdentity()?.email ?? null,
    claude,
    codex,
    agy,
    tools,
    vendors: vendorsPayload(root),
    settings: effectiveSettings(settingsRaw),
  };
}

/**
 * `statusline`: local reads only — active account + best other by cached
 * headroom. Runs before TLS/theme setup in Python; here it is a pure
 * function of fixture-safe files.
 */
export interface Statusline {
  schemaVersion: 1;
  active: { slot: string; email: string; alias: string | null } | null;
  managed: boolean;
  bestOther: { slot: string; email: string } | null;
}

export function collectStatusline(root: string = backupRoot()): Statusline {
  const claude = claudeAccountsPayload(root);
  const active = claude.active;
  const activeRec = active !== null ? claude.accounts.find((a) => a.slot === active) : undefined;
  const live = liveIdentity();
  // Best other: lowest worst-percent among enabled, non-active cached rows.
  const usage = new Map(loadClaudeUsage(root).map((u) => [u.slot, u.lastGood]));
  let best: { slot: string; email: string; pct: number } | null = null;
  for (const a of claude.accounts) {
    if (a.disabled || a.slot === active) continue;
    const pct = worstPct(usage.get(a.slot)) ?? 101;
    if (best === null || pct < best.pct) best = { slot: a.slot, email: a.email, pct };
  }
  const activeEmail = live?.email ?? activeRec?.email ?? null;
  return {
    schemaVersion: 1,
    active: activeEmail !== null
      ? { slot: active ?? "", email: activeEmail, alias: activeRec?.alias ?? null }
      : null,
    managed: active !== null,
    bestOther: best !== null ? { slot: best.slot, email: best.email } : null,
  };
}
