/**
 * ccswap TS dispatcher entry (strangler wave 1).
 *
 * Ported read-only commands run here in TypeScript. Everything else falls
 * through to the existing Python CLI with identical argv and exit code.
 * Porting cut: docs/migration/behavior-matrix.md § "Wave-1 porting cut".
 */

import path from "node:path";
import { readJsonFile } from "./platform/domain/jsonFile.js";
import { backupRoot, VENDOR_TOOLS } from "./platform/domain/paths.js";
import { isPorted, runPythonFallback } from "./platform/application/dispatcher.js";
import {
  agyAccountsPayload,
  claudeAccountsPayload,
  claudeActiveSlot,
  codexAccountsPayload,
  renderAccountsHuman,
} from "./accounts/application/listAccounts.js";
import { liveIdentity } from "./accounts/adapters/liveIdentity.js";
import { loadClaudeRoster } from "./accounts/adapters/roster.js";
import {
  loadClaudeUsage,
  loadVendorUsage,
  vendorUsageFor,
} from "./usage/application/readUsage.js";
import type { VendorUsageResult } from "./usage/domain/usageCache.js";
import {
  capabilitiesPayload,
  knownCapabilityTools,
  renderVendorsHuman,
  vendorsPayload,
} from "./vendors/application/listVendors.js";
import { toolAccounts } from "./vendors/adapters/vendorStore.js";
import { loadVendorsDoc } from "./vendors/adapters/vendorStore.js";
import {
  effectiveSettings,
  formatSettingValue,
  SETTING_SPECS,
} from "./config/domain/settings.js";

function emitJson(payload: unknown): number {
  console.log(JSON.stringify(payload, null, 2));
  return 0;
}

function fail(message: string, asJson: boolean): number {
  if (asJson) {
    console.log(JSON.stringify({ schemaVersion: 1, error: message }, null, 2));
  } else {
    console.error(`Error: ${message}`);
  }
  return 1;
}

function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

// ---- list / status -------------------------------------------------------

function cmdList(argv: string[], provider: string): number {
  const asJson = hasFlag(argv, "--json");
  const root = backupRoot();
  if (provider === "all") {
    const claude = claudeAccountsPayload(root);
    const codex = codexAccountsPayload(root);
    const agy = agyAccountsPayload(root);
    if (asJson) return emitJson({ schemaVersion: 1, liveRefresh: false, claude, codex, agy });
    return emitJson({ schemaVersion: 1, liveRefresh: false, claude, codex, agy });
  }
  const payload =
    provider === "codex"
      ? codexAccountsPayload(root)
      : provider === "agy"
        ? agyAccountsPayload(root)
        : claudeAccountsPayload(root);
  if (asJson) return emitJson(payload);
  for (const line of renderAccountsHuman(provider, payload.accounts)) console.log(line);
  return 0;
}

function cmdStatus(argv: string[]): number {
  const asJson = hasFlag(argv, "--json");
  const root = backupRoot();
  // Python parity: status derives the active account from the LIVE login
  // (`oauthAccount` in the global config), never from `activeAccountNumber`.
  const live = liveIdentity();
  if (live === null) {
    if (asJson) return emitJson({ schemaVersion: 1, active: null });
    console.log("Status: No active Claude account");
    return 0;
  }
  const { sequence, unreadable } = loadClaudeRoster(root);
  if (unreadable) return fail("Claude account data is unreadable", asJson);
  const slot = claudeActiveSlot(root);
  if (slot === null) {
    if (asJson) {
      return emitJson({ schemaVersion: 1, active: { email: live.email, managed: false } });
    }
    console.log(`Status: ${live.email} (not managed)`);
    return 0;
  }
  const entry = sequence.accounts[slot];
  if (entry === undefined) return fail("Claude account data is unreadable", asJson);
  const active: Record<string, unknown> = {
    number: Number(slot),
    email: live.email,
    organizationName: entry.organizationName,
    organizationUuid: entry.organizationUuid,
    isOrganization: entry.organizationUuid !== "",
    managed: true,
    // Live usage evaluation stays in Python (wave 1).
    usageStatus: "unknown",
    usage: null,
  };
  if (entry.alias !== undefined) active["alias"] = entry.alias;
  if (asJson) {
    return emitJson({
      schemaVersion: 1,
      active,
      totalManagedAccounts: Object.keys(sequence.accounts).length,
    });
  }
  console.log(`Active: [${slot}] ${live.email}`);
  return 0;
}

// ---- per-vendor list -----------------------------------------------------

function cmdVendorList(tool: string, argv: string[]): number {
  const asJson = hasFlag(argv, "--json");
  const root = backupRoot();
  const { doc, unreadable } = loadVendorsDoc(root);
  if (unreadable) return fail("Vendor account data is unreadable", asJson);
  // Wave 1 performs no vendor identity probes (`whoami`/`auth list`), so the
  // stored active mark stays unconfirmed (Python parity: `active: null`).
  // The stored value is exposed as `storedActive` for transparency.
  const storedActive = doc?.tools[tool]?.active ?? null;
  const accounts: Array<{
    alias: string;
    kind: string;
    provider: string | null;
    identity: Record<string, string>;
    registered: boolean;
    active: boolean | null;
    note: string;
  }> = toolAccounts(doc, tool).map((a) => ({
    alias: a.alias,
    kind: a.kind,
    provider: a.provider,
    identity: a.identity,
    registered: true,
    active: null,
    note: `stored active is '${storedActive ?? "none"}'; unverified in TS wave 1 (no vendor identity probe)`,
  }));
  if (asJson) {
    return emitJson({ schemaVersion: 1, tool, liveRefresh: false, storedActive, accounts });
  }
  if (accounts.length === 0) {
    console.log(`No ${tool} accounts registered.`);
    return 0;
  }
  for (const a of accounts) {
    console.log(`${a.active ? "*" : " "} ${a.alias}${a.provider ? ` [${a.provider}]` : ""}`);
  }
  return 0;
}

// ---- vendors ---------------------------------------------------------------

function cmdVendors(argv: string[]): number {
  const asJson = hasFlag(argv, "--json");
  const [sub, tool] = argv.filter((a) => !a.startsWith("--"));
  if (sub === "capabilities") {
    if (tool !== undefined && !knownCapabilityTools().includes(tool)) {
      return fail(`Unknown vendor '${tool}'. Known: ${knownCapabilityTools().join(", ")}`, asJson);
    }
    const tools = tool === undefined ? knownCapabilityTools() : [tool];
    const payload = capabilitiesPayload(tools);
    if (asJson) return emitJson(payload);
    for (const [name, table] of Object.entries(payload.vendors)) {
      console.log(name);
      for (const [cap, row] of Object.entries(table)) {
        console.log(`  ${cap.padEnd(22)} ${row.support.padEnd(12)} ${row.mechanism}`);
      }
    }
    return 0;
  }
  if (sub !== undefined && sub !== "status") {
    return fail(`Unknown vendors action '${sub}'`, asJson);
  }
  const payload = vendorsPayload();
  if (asJson) return emitJson(payload);
  for (const line of renderVendorsHuman(payload.vendors)) console.log(line);
  return 0;
}

// ---- usage (cached only) -----------------------------------------------------

const LEGACY_TOOLS = new Set(["claude", "codex", "agy"]);

function cmdUsage(argv: string[]): number {
  const asJson = hasFlag(argv, "--json");
  const tools = argv.filter((a) => !a.startsWith("--"));
  const root = backupRoot();
  const cache = loadVendorUsage(root);
  const claudeUsage = new Map(loadClaudeUsage(root).map((u) => [u.slot, u]));
  const selected = tools.length > 0 ? tools : ["claude", "codex", "muse", "kiro", "opencode", "agy"];
  for (const t of selected) {
    if (![...VENDOR_TOOLS, ...LEGACY_TOOLS].includes(t as never)) {
      return fail(`Unknown tool: ${t}`, asJson);
    }
  }
  const out = selected.map((tool) => {
    if (LEGACY_TOOLS.has(tool)) {
      const roster =
        tool === "codex"
          ? codexAccountsPayload(root)
          : tool === "agy"
            ? agyAccountsPayload(root)
            : claudeAccountsPayload(root);
      return {
        tool,
        liveRefresh: false as const,
        accounts: roster.accounts.map((a) => ({
          // Python parity: unaliased legacy accounts are labeled by slot.
          alias: a.alias ?? a.slot,
          state: "unknown",
          reason: "cached reading only in wave 1; pass --refresh for a live reading (Python)",
          usageCached: tool === "claude" ? (claudeUsage.has(a.slot) ? true : false) : false,
        })),
      };
    }
    const { doc } = loadVendorsDoc(root);
    const accounts = toolAccounts(doc, tool);
    return {
      tool,
      liveRefresh: false as const,
      accounts: accounts.map((a) => {
        const cached: VendorUsageResult | null = vendorUsageFor(cache, tool, a.alias);
        if (cached === null) {
          return { alias: a.alias, state: "unknown", reason: "no cached reading" };
        }
        return { alias: a.alias, ...cached };
      }),
    };
  });
  // Wave 1 renders `usage` as JSON only (no human table yet).
  return emitJson({ schemaVersion: 1, liveRefresh: false, tools: out });
}

// ---- config -------------------------------------------------------------------

function cmdConfig(argv: string[]): number {
  const asJson = hasFlag(argv, "--json");
  const root = backupRoot();
  const rest: Array<string | undefined> = argv.filter((a) => !a.startsWith("--"));
  const action: string | undefined = rest[0];
  const key: string | undefined = rest[1];
  const settingsPath = path.join(root, "settings.json");
  const raw = readJsonFile(settingsPath);
  if (action === "path") {
    console.log(settingsPath);
    return 0;
  }
  if (action === undefined || action === "list") {
    const rows = effectiveSettings(raw);
    if (asJson) {
      return emitJson({
        schemaVersion: 1,
        path: settingsPath,
        settings: rows.map((r) => ({ key: r.key, value: r.value, isSet: r.isSet })),
      });
    }
    const keyW = Math.max(...rows.map((r) => r.key.length));
    const valW = Math.max(...rows.map((r) => formatSettingValue(r.value).length));
    for (const r of rows) {
      const line = `${r.key.padEnd(keyW)}  ${formatSettingValue(r.value).padEnd(valW)}`;
      console.log(r.isSet ? line : `${line}  (default)`);
    }
    return 0;
  }
  if (action === "get") {
    const spec = SETTING_SPECS.find((s) => s.dotted === key);
    if (!spec) return fail(`unknown setting '${key ?? ""}'`, asJson);
    const row = effectiveSettings(raw).find((r) => r.key === spec.dotted);
    if (asJson) {
      return emitJson({ schemaVersion: 1, key: spec.dotted, value: row?.value, isSet: row?.isSet });
    }
    console.log(formatSettingValue(row?.value));
    return 0;
  }
  return fail(`Unknown config action '${action}'`, asJson);
}

// ---- alias / map (list forms) ----------------------------------------------------

function cmdAliasList(): number {
  const { sequence, unreadable } = loadClaudeRoster();
  if (unreadable) return fail("Claude account data is unreadable", false);
  const rows = Object.entries(sequence.accounts)
    .filter(([, rec]) => rec.alias !== undefined)
    .map(([slot, rec]) => ({ slot, alias: rec.alias as string, email: rec.email }));
  if (rows.length === 0) {
    console.log("No aliases set");
    return 0;
  }
  console.log("Aliases:");
  for (const r of rows) console.log(`  ${r.slot}: ${r.alias} (${r.email})`);
  return 0;
}

function cmdMapList(): number {
  const root = backupRoot();
  const raw = readJsonFile(path.join(root, "mappings.json"));
  const doc =
    typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const table = doc["mappings"];
  const mappings: Record<string, unknown> =
    typeof table === "object" && table !== null ? (table as Record<string, unknown>) : {};
  const dirs = Object.keys(mappings).sort();
  if (dirs.length === 0) {
    console.log("No directory mappings yet.");
    console.log("Map one with: ccswap map <NUM|EMAIL> [PATH]");
    return 0;
  }
  const { sequence } = loadClaudeRoster(root);
  console.log("Directory mappings:");
  for (const dir of dirs) {
    const record = mappings[dir];
    const entry: Record<string, unknown> =
      typeof record === "object" && record !== null ? (record as Record<string, unknown>) : {};
    const email = str(entry["email"]);
    const org = str(entry["organizationUuid"]);
    const slot = Object.entries(sequence.accounts).find(
      ([, rec]) => rec.email === email && rec.organizationUuid === org,
    )?.[0];
    if (slot !== undefined) {
      const orgName = sequence.accounts[slot]?.organizationName ?? "";
      console.log(`  ${dir} → ${slot}: ${email} [${orgName !== "" ? orgName : "personal"}]`);
    } else {
      console.log(`  ${dir} → ${email} (account removed)`);
    }
  }
  return 0;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}


export function run(argv: string[]): number {
  const [first, second] = argv;
  if (first === "list" || first === "ls") {
    const rawProvider: unknown = argv.includes("--provider")
      ? argv[argv.indexOf("--provider") + 1]
      : "all";
    const provider = typeof rawProvider === "string" ? rawProvider : "all";
    if (!["all", "claude", "codex", "agy"].includes(provider)) {
      if (hasFlag(argv, "--json")) {
        return fail(`Unknown provider: ${provider}`, true);
      }
      console.error(`Error: Unknown provider: ${provider}`);
      return 2;
    }
    return cmdList(argv, provider);
  }
  if (first === "status") return cmdStatus(argv);
  if (first === "claude" && (second === "list" || second === "ls" || second === "usage")) {
    return cmdList(argv, "claude");
  }
  if (first === "codex" && (second === "list" || second === "accounts")) return cmdList(argv, "codex");
  if (first === "agy" && (second === "list" || second === "status" || second === "usage")) {
    if (second === "status") {
      const asJson = hasFlag(argv, "--json");
      const payload = agyAccountsPayload();
      const activeEntry = payload.accounts.find((a) => a.active);
      if (asJson) {
        // Python parity: `agy.status` JSON shape (no schemaVersion).
        return emitJson({
          provider: "agy",
          activeAccountNumber: payload.active === null ? null : Number(payload.active),
          email: activeEntry?.email ?? null,
        });
      }
      for (const line of renderAccountsHuman("agy", payload.accounts)) console.log(line);
      return 0;
    }
    return cmdList(argv, "agy");
  }
  if (first !== undefined && (VENDOR_TOOLS as readonly string[]).includes(first)) {
    return cmdVendorList(first, argv.slice(1));
  }
  if (first === "vendors" || first === "tools") return cmdVendors(argv.slice(1));
  if (first === "usage") return cmdUsage(argv.slice(1));
  if (first === "config") return cmdConfig(argv.slice(1));
  if (first === "alias") return cmdAliasList();
  if (first === "map") return cmdMapList();
  // Unreachable when called via main(); kept for direct use.
  const res = runPythonFallback(argv);
  return res.status ?? (res.signal === null ? 1 : 128);
}

function main(): void {
  const argv = process.argv.slice(2);
  if (!isPorted(argv)) {
    const res = runPythonFallback(argv);
    if (res.signal !== null) {
      process.kill(process.pid, res.signal);
    }
    process.exit(res.status ?? 1);
  }
  process.exit(run(argv));
}

// Auto-run only when invoked as the CLI entry (bundle or tsx/node), never
// when imported (e.g. by vitest).
const invokedAsCli =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("main.ts") || process.argv[1].endsWith("ccswap.mjs"));
if (invokedAsCli) main();
