/**
 * ccswap TS dispatcher entry (strangler wave 2).
 *
 * Ported commands run here in TypeScript. Everything else falls through to
 * the existing Python CLI with identical argv and exit code. Porting cut:
 * docs/migration/behavior-matrix.md §§ "Wave-1 porting cut" + wave 2
 * (file-backed mutations, local probes, overview/statusline backends).
 *
 * Any use-case that hits an unported sub-condition (macOS Keychain-only
 * backups, live session-mode profiles, interactive prompts, browser or
 * vendor-native flows) returns `handled: false`, and `run()` falls back to
 * the Python CLI with the original argv — so output parity is exact.
 */

import fs from "node:fs";
import path from "node:path";
import { readJsonFile } from "./platform/domain/jsonFile.js";
import { backupRoot, VENDOR_TOOLS } from "./platform/domain/paths.js";
import { type FallbackResult, claudeRewritten, isPorted, runPythonFallback } from "./platform/application/dispatcher.js";
import {
  addAccount,
  addToken,
  aliasSet,
  aliasUnset,
  disableAccount,
  enableAccount,
  moveAccount,
  removeAccount,
  swapAccounts,
  switchAccount,
  type UseCaseResult,
} from "./accounts/application/manageAccounts.js";
import { exportAccounts, importAccounts, importUsage, listUnclaimed, purgeUnclaimed } from "./accounts/application/transferAccounts.js";
import { liveIdentity } from "./accounts/adapters/liveIdentity.js";
import { loadClaudeRoster } from "./accounts/adapters/roster.js";
import {
  loadClaudeUsage,
  loadVendorUsage,
  vendorUsageFor,
} from "./usage/application/readUsage.js";
import { refreshUsage } from "./usage/application/refreshUsage.js";
import type { VendorUsageResult } from "./usage/domain/usageCache.js";
import {
  capabilitiesWithGrok,
  GROK_TOOL,
  knownCapabilityTools,
  renderVendorsHuman,
  vendorsPayload,
} from "./vendors/application/listVendors.js";
import { toolAccounts } from "./vendors/adapters/vendorStore.js";
import { loadVendorsDoc } from "./vendors/adapters/vendorStore.js";
import {
  vendorAdd,
  vendorRemove,
  vendorRun,
  vendorStatus,
  vendorSwitch,
} from "./vendors/application/manageVendors.js";
import {
  effectiveSettings,
  formatSettingValue,
  SETTING_SPECS,
} from "./config/domain/settings.js";
import { configSet, configUnset } from "./config/application/writeSettings.js";
import { mapAccount, unmapPath } from "./mappings/application/manageMappings.js";
import { codexAdd, codexRemove, codexSwitch } from "./codex/application/manageCodex.js";
import { codexIdentity, parseCodexAuth } from "./codex/domain/codexRoster.js";
import { codexLiveAuthPath, readCodexSequence } from "./codex/adapters/codexStore.js";
import { agyRemove } from "./agy/application/manageAgy.js";
import { collectOverview, collectStatusline } from "./overview/application/collect.js";
import {
  agyAccountsPayload,
  claudeAccountsPayload,
  claudeActiveSlot,
  codexAccountsPayload,
  renderAccountsHuman,
} from "./accounts/application/listAccounts.js";

function emitJson(payload: unknown): number {
  console.log(JSON.stringify(payload, null, 2));
  return 0;
}

function fail(message: string, asJson: boolean, code = 1): number {
  if (asJson) {
    console.log(JSON.stringify({ schemaVersion: 1, error: message }, null, 2));
  } else {
    console.error(`Error: ${message}`);
  }
  return code;
}

function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

/** `--slot 2` / `--slot=2` value (null when absent). */
function flagValue(argv: string[], flag: string): string | null {
  const idx = argv.indexOf(flag);
  if (idx >= 0 && idx + 1 < argv.length) return argv[idx + 1] as string;
  const prefixed = argv.find((a) => a.startsWith(`${flag}=`));
  if (prefixed) return prefixed.slice(flag.length + 1);
  return null;
}

function intFlag(argv: string[], flag: string): number | undefined {
  const v = flagValue(argv, flag);
  if (v === null) return undefined;
  const n = Number(v);
  return Number.isInteger(n) ? n : undefined;
}

/** Non-flag positionals (skip `=value` spellings of consumed flags). */
function positionals(argv: string[], consume: string[] = []): string[] {
  const out: string[] = [];
  let skipNext = false;
  for (const a of argv) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (consume.includes(a)) {
      skipNext = true;
      continue;
    }
    if (a.includes("=") && consume.includes(a.slice(0, a.indexOf("=")))) continue;
    if (a.startsWith("--")) continue;
    out.push(a);
  }
  return out;
}

/** Route a use-case result: fallback when unhandled, else print + exit code. */
function settle(res: UseCaseResult, originalArgv: string[], asJson: boolean): number {
  if (!res.handled) {
    const fb = runPythonFallback(originalArgv);
    return fb.status ?? 1;
  }
  if (res.payload !== undefined && asJson) return emitJson(res.payload);
  if (res.payload !== undefined && typeof res.payload === "object" && "stdout" in res.payload) {
    process.stdout.write(String((res.payload)["stdout"]));
    if (res.code === 0) console.log(res.message);
    return res.code;
  }
  if (res.code === 0) {
    console.log(res.message);
    return 0;
  }
  return fail(res.message, asJson, res.code);
}

function settleSyncStdout(res: UseCaseResult, originalArgv: string[], asJson: boolean): number {
  const out = settle(res, originalArgv, asJson);
  if (typeof out === "number") return out;
  throw new Error("unreachable: sync use-case returned a promise");
}

// ---- list / status (wave 1, unchanged) ---------------------------------------

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

function cmdStatusline(argv: string[]): number {
  const asJson = hasFlag(argv, "--json");
  const root = backupRoot();
  const status = collectStatusline(root);
  if (asJson) return emitJson(status);
  if (status.active === null) {
    console.log("ccswap: no active account");
    return 0;
  }
  const alias = status.active.alias !== null ? ` (${status.active.alias})` : "";
  const other = status.bestOther !== null ? ` | best other: [${status.bestOther.slot}] ${status.bestOther.email}` : "";
  console.log(`[${status.active.slot}] ${status.active.email}${alias}${other}`);
  return 0;
}

// ---- switch / rotation --------------------------------------------------------

function rotateTarget(root: string): string | null {
  const { sequence } = loadClaudeRoster(root);
  const enabled = [...sequence.sequence]
    .map(String)
    .filter((s) => {
      const rec = sequence.accounts[s];
      return rec !== undefined && !rec.disabled;
    });
  if (enabled.length === 0) return null;
  const live = liveIdentity();
  const cur = live !== null
    ? enabled.find((s) => {
        const rec = sequence.accounts[s];
        return rec !== undefined && rec.email === live.email && rec.organizationUuid === live.organizationUuid;
      })
    : undefined;
  if (cur === undefined) return enabled[0] as string;
  return enabled[(enabled.indexOf(cur) + 1) % enabled.length] as string;
}

function cmdSwitch(argv: string[], originalArgv: string[]): number {
  const asJson = hasFlag(argv, "--json");
  const root = backupRoot();
  const strategyRaw = flagValue(argv, "--strategy");
  const strategy = strategyRaw as "best" | "next-available" | "consume-first" | null;
  if (strategy !== null && !["best", "next-available", "consume-first"].includes(strategy)) {
    return fail(`Unknown strategy: ${strategy}`, asJson, 2);
  }
  const force = hasFlag(argv, "--force");
  const positional = positionals(argv.slice(1), ["--strategy"]);
  let target = positional[0] ?? null;
  if (target === null && strategy === null) {
    // Bare `switch` rotates to the next enabled account (Python parity).
    target = rotateTarget(root);
    if (target === null) return fail("No accounts are managed yet", asJson);
  }
  const res = switchAccount(root, target, { strategy: strategy ?? undefined, json: asJson, force });
  return settle(res, originalArgv, asJson);
}

// ---- per-vendor list -----------------------------------------------------

function cmdVendorList(tool: string, argv: string[]): number {
  const asJson = hasFlag(argv, "--json");
  if (tool === "grok") {
    if (asJson) {
      return emitJson({ schemaVersion: 1, tool, liveRefresh: false, storedActive: null, accounts: [] });
    }
    console.log("No grok accounts registered (no supported account mechanism yet).");
    return 0;
  }
  const root = backupRoot();
  const { doc, unreadable } = loadVendorsDoc(root);
  if (unreadable) return fail("Vendor account data is unreadable", asJson);
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
    note: `stored active is '${storedActive ?? "none"}'; unverified in TS wave 2 (no vendor identity probe)`,
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

function cmdVendorStatus(tool: string, argv: string[]): number {
  const asJson = hasFlag(argv, "--json");
  const res = vendorStatus(backupRoot(), tool);
  if (!res.handled || res.code !== 0) return fail(res.message, asJson, res.code);
  if (asJson) return emitJson(res.payload);
  const p = res.payload as { active: string | null; accounts: number };
  console.log(`${tool}: ${String(p.accounts)} account(s)${p.active ? `, active: ${p.active}` : ""}`);
  return 0;
}

// ---- vendors ---------------------------------------------------------------

function cmdVendors(argv: string[]): number {
  const asJson = hasFlag(argv, "--json");
  const [sub, tool] = argv.filter((a) => !a.startsWith("--"));
  if (sub === "capabilities") {
    const known = [...knownCapabilityTools(), GROK_TOOL];
    if (tool !== undefined && !known.includes(tool)) {
      return fail(`Unknown vendor '${tool}'. Known: ${known.join(", ")}`, asJson);
    }
    // Bare `vendors capabilities` matches Python exactly (muse/kiro);
    // grok is answered only when asked for explicitly (no Python counterpart).
    const tools = tool === undefined ? knownCapabilityTools() : [tool];
    const vendors = capabilitiesWithGrok(tool === "grok" ? [GROK_TOOL] : tools);
    const payload = { schemaVersion: 1 as const, vendors };
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

// ---- usage -------------------------------------------------------------------

const LEGACY_TOOLS = new Set(["claude", "codex", "agy"]);

function cmdUsageCached(argv: string[]): number {
  const asJson = hasFlag(argv, "--json");
  const tools = argv.filter((a) => !a.startsWith("--"));
  const root = backupRoot();
  const cache = loadVendorUsage(root);
  const claudeUsage = new Map(loadClaudeUsage(root).map((u) => [u.slot, u]));
  const selected = tools.length > 0 ? tools : ["claude", "codex", "muse", "kiro", "agy"];
  for (const t of selected) {
    if (![...VENDOR_TOOLS, ...LEGACY_TOOLS, "grok"].includes(t)) {
      return fail(`Unknown tool: ${t}`, asJson);
    }
  }
  const out = selected.map((tool) => {
    if (tool === "grok") {
      return { tool, liveRefresh: false as const, accounts: [], note: "no supported account mechanism yet" };
    }
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
          alias: a.alias ?? a.slot,
          state: "unknown",
          reason: "cached reading only; pass --refresh for a live reading",
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
  return emitJson({ schemaVersion: 1, liveRefresh: false, tools: out });
}

async function cmdUsage(argv: string[], originalArgv: string[]): Promise<number> {
  const asJson = hasFlag(argv, "--json");
  const wantsRefresh = hasFlag(argv, "--refresh");
  const wantsCheck = hasFlag(argv, "--check");
  if (!wantsRefresh && !wantsCheck) return cmdUsageCached(argv);
  const tools = argv.filter((a) => !a.startsWith("--"));
  const res = await refreshUsage(backupRoot(), tools, { check: wantsCheck });
  const out = settle(res, originalArgv, asJson);
  return typeof out === "number" ? out : 0;
}

// ---- config -------------------------------------------------------------------

function cmdConfig(argv: string[], originalArgv: string[]): number {
  const asJson = hasFlag(argv, "--json");
  const root = backupRoot();
  const rest: Array<string | undefined> = argv.filter((a) => !a.startsWith("--"));
  const action: string | undefined = rest[0];
  const key: string | undefined = rest[1];
  if (action === "set") {
    const value = rest[2];
    if (key === undefined || value === undefined) return fail("config set needs KEY and VALUE", asJson, 2);
    return settleSyncStdout(configSet(root, key, value), originalArgv, asJson);
  }
  if (action === "unset") {
    if (key === undefined) return fail("config unset needs KEY", asJson, 2);
    return settleSyncStdout(configUnset(root, key), originalArgv, asJson);
  }
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

// ---- alias / map (wave 1 list + wave 2 mutations) --------------------------------

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

function cmdAlias(argv: string[], originalArgv: string[]): number {
  const asJson = hasFlag(argv, "--json");
  const root = backupRoot();
  const rest = positionals(argv.slice(1));
  if (rest.length === 0) {
    if (asJson) {
      const { sequence } = loadClaudeRoster(root);
      const rows = Object.entries(sequence.accounts)
        .filter(([, rec]) => rec.alias !== undefined)
        .map(([slot, rec]) => ({ slot, alias: rec.alias, email: rec.email }));
      return emitJson({ schemaVersion: 1, aliases: rows });
    }
    return cmdAliasList();
  }
  if (rest.length === 1 && hasFlag(argv, "--unset")) {
    return settleSyncStdout(aliasUnset(root, rest[0] as string), originalArgv, asJson);
  }
  if (rest.length === 2) {
    return settleSyncStdout(aliasSet(root, rest[0] as string, rest[1] as string), originalArgv, asJson);
  }
  return fail("Usage: ccswap alias [NUM|EMAIL [NAME|--unset]]", asJson, 2);
}

function cmdMap(argv: string[], originalArgv: string[]): number {
  const asJson = hasFlag(argv, "--json");
  const rest = positionals(argv.slice(1));
  if (rest.length === 0) return cmdMapList();
  return settleSyncStdout(mapAccount(backupRoot(), rest[0] as string, rest[1]), originalArgv, asJson);
}

function cmdUnmap(argv: string[], originalArgv: string[]): number {
  const asJson = hasFlag(argv, "--json");
  const rest = positionals(argv.slice(1));
  if (rest.length > 1) return fail("Usage: ccswap unmap [PATH]", asJson, 2);
  return settleSyncStdout(unmapPath(backupRoot(), rest[0]), originalArgv, asJson);
}

function cmdUnclaimed(argv: string[], originalArgv: string[]): number {
  const asJson = hasFlag(argv, "--json");
  const root = backupRoot();
  const purgeId = flagValue(argv, "--purge");
  if (purgeId !== null) {
    return settleSyncStdout(purgeUnclaimed(root, purgeId), originalArgv, asJson);
  }
  const rest = positionals(argv.slice(1));
  if (rest.length > 0) return fail("Usage: ccswap unclaimed [--purge ID]", asJson, 2);
  try {
    const { entries } = listUnclaimed(root);
    if (asJson) return emitJson({ schemaVersion: 1, entries: Object.keys(entries) });
    const ids = Object.keys(entries).sort();
    if (ids.length === 0) {
      console.log("No unclaimed credential entries");
      return 0;
    }
    for (const id of ids) {
      const meta = entries[id] as Record<string, unknown>;
      const slotVal = meta["configSlot"];
      const reasonVal = meta["reason"];
      const slotText = typeof slotVal === "string" || typeof slotVal === "number" ? String(slotVal) : "?";
      const reasonText = typeof reasonVal === "string" ? reasonVal : "orphaned (no manifest row)";
      console.log(`${id}  slot ${slotText}  ${reasonText}`);
    }
    return 0;
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err), asJson);
  }
}

// ---- add / remove / disable / swap / move ------------------------------------------

function cmdAdd(argv: string[], originalArgv: string[]): number {
  const asJson = hasFlag(argv, "--json");
  const root = backupRoot();
  const slot = intFlag(argv, "--slot");
  if (flagValue(argv, "--slot") !== null && slot === undefined) {
    return fail("--slot needs a positive integer", asJson, 2);
  }
  return settleSyncStdout(
    addAccount(root, { slot, alias: flagValue(argv, "--alias") ?? undefined, assumeYes: hasFlag(argv, "--yes") }),
    originalArgv,
    asJson,
  );
}

function cmdAddToken(argv: string[], originalArgv: string[]): number {
  const asJson = hasFlag(argv, "--json");
  const root = backupRoot();
  const rest = positionals(argv.slice(1), ["--slot", "--email"]);
  let token = rest[0] ?? "";
  if (token === "-") {
    token = fs.readFileSync(0, "utf-8").split("\n")[0] ?? "";
  } else if (token === "" && !process.stdin.isTTY) {
    try {
      const stdinText = fs.readFileSync(0, "utf-8");
      if (stdinText.trim() !== "") token = stdinText.split("\n")[0] as string;
    } catch {
      // No stdin: leave empty so the use-case raises the empty-token error.
    }
  }
  const slot = intFlag(argv, "--slot");
  if (flagValue(argv, "--slot") !== null && slot === undefined) {
    return fail("--slot needs a positive integer", asJson, 2);
  }
  return settleSyncStdout(
    addToken(root, token, { email: flagValue(argv, "--email") ?? undefined, slot, assumeYes: hasFlag(argv, "--yes") }),
    originalArgv,
    asJson,
  );
}

function cmdSwap(argv: string[], originalArgv: string[]): number {
  const asJson = hasFlag(argv, "--json");
  const rest = positionals(argv.slice(1));
  if (rest.length !== 2) return fail("Usage: ccswap swap NUM|EMAIL|ALIAS NUM|EMAIL|ALIAS", asJson, 2);
  return settleSyncStdout(swapAccounts(backupRoot(), rest[0] as string, rest[1] as string), originalArgv, asJson);
}

function cmdMove(argv: string[], originalArgv: string[]): number {
  const asJson = hasFlag(argv, "--json");
  const rest = positionals(argv.slice(1));
  if (rest.length !== 2) return fail("Usage: ccswap move NUM|EMAIL SLOT", asJson, 2);
  return settleSyncStdout(moveAccount(backupRoot(), rest[0] as string, rest[1] as string), originalArgv, asJson);
}

// ---- export / import ------------------------------------------------------------------

function cmdExport(argv: string[], originalArgv: string[]): number {
  const asJson = hasFlag(argv, "--json");
  const rest = positionals(argv, ["--account"]);
  const dest = rest[0];
  if (!dest) return fail("Usage: ccswap export PATH [--account NUM|EMAIL] [--full]", asJson, 2);
  const account = flagValue(argv, "--account");
  const full = hasFlag(argv, "--full");
  const res = exportAccounts(backupRoot(), dest, account, full, () => null);
  if (!res.handled) {
    const fb = runPythonFallback(originalArgv);
    return fb.status ?? 1;
  }
  if (res.code !== 0) return fail(res.message, asJson, res.code);
  if (dest === "-") {
    process.stdout.write(String((res.payload as Record<string, unknown>)["stdout"]));
    return 0;
  }
  if (asJson) return emitJson({ schemaVersion: 1, message: res.message });
  console.log(res.message);
  return 0;
}

function cmdImport(argv: string[], originalArgv: string[]): number {
  const asJson = hasFlag(argv, "--json");
  const rest = positionals(argv);
  if (rest.length !== 1) return fail("Usage: ccswap import PATH [--force]", asJson, 2);
  const readSource = (source: string): string => {
    if (source === "-") return fs.readFileSync(0, "utf-8");
    return fs.readFileSync(source, "utf-8");
  };
  return settleSyncStdout(importAccounts(backupRoot(), rest[0] as string, readSource, hasFlag(argv, "--force")), originalArgv, asJson);
}

function cmdImportUsage(argv: string[], originalArgv: string[]): number {
  const asJson = hasFlag(argv, "--json");
  const rest = positionals(argv, ["--hold"]);
  if (rest.length !== 1) return fail("Usage: ccswap import-usage PATH [--hold SECONDS]", asJson, 2);
  const holdRaw = flagValue(argv, "--hold");
  const hold = holdRaw !== null ? Number(holdRaw) : null;
  if (holdRaw !== null && !Number.isFinite(hold)) return fail("--hold needs a number", asJson, 2);
  const readSource = (source: string): string => {
    if (source === "-") return fs.readFileSync(0, "utf-8");
    return fs.readFileSync(source, "utf-8");
  };
  return settleSyncStdout(importUsage(backupRoot(), rest[0] as string, readSource, hold), originalArgv, asJson);
}

// ---- codex -------------------------------------------------------------------------------

function cmdCodex(argv: string[], originalArgv: string[]): number | Promise<number> {
  const [action, ...rest] = argv;
  const asJson = hasFlag(argv, "--json");
  const root = backupRoot();
  if (action === "list" || action === "accounts") return cmdList(["--json", "--provider", "codex"].concat(asJson ? ["--json"] : []), "codex");
  if (action === "status") {
    try {
      const seq = readCodexSequence(root);
      const liveText = (() => {
        try {
          return fs.readFileSync(codexLiveAuthPath(), "utf-8");
        } catch {
          return null;
        }
      })();
      let email: string | null = null;
      if (liveText) {
        try {
          const parsed = parseCodexAuth(JSON.parse(liveText));
          if (parsed) email = codexIdentity(parsed).email;
        } catch {
          // Unreadable live auth → logged-out parity.
        }
      }
      const active = email !== null
        ? Object.entries(seq.accounts).find(([, rec]) => rec.email === email)?.[0] ?? null
        : null;
      if (asJson) {
        return emitJson({
          schemaVersion: 1,
          provider: "codex",
          activeAccountNumber: active !== null ? Number(active) : null,
          email,
        });
      }
      if (email === null) {
        console.log("Status: No active Codex account");
        return 0;
      }
      console.log(active !== null ? `Active Codex: [${active}] ${email}` : `Active Codex: ${email} (not managed)`);
      return 0;
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err), asJson);
    }
  }
  if (action === "add") {
    const slot = intFlag(argv, "--slot");
    return settleSyncStdout(codexAdd(root, slot, hasFlag(argv, "--yes")), originalArgv, asJson);
  }
  if (action === "remove") {
    const [target] = positionals(rest);
    if (!target) return fail("Usage: ccswap codex remove NUM|EMAIL [--yes]", asJson, 2);
    return settleSyncStdout(codexRemove(root, target, hasFlag(argv, "--yes")), originalArgv, asJson);
  }
  if (action === "switch") {
    const strategy = flagValue(argv, "--strategy") as "best" | "next-available" | "consume-first" | null;
    const [target] = positionals(rest, ["--strategy"]);
    if (target && strategy) return fail("--strategy can only be used with bare 'switch'", asJson, 2);
    return settle(codexSwitch(root, target ?? null, { json: asJson, strategy: strategy ?? undefined }), originalArgv, asJson);
  }
  const fb: FallbackResult = runPythonFallback(originalArgv);
  return fb.status ?? 1;
}

// ---- agy ----------------------------------------------------------------------------------

function cmdAgy(argv: string[], originalArgv: string[]): number {
  const [action, ...rest] = argv;
  const asJson = hasFlag(argv, "--json");
  const root = backupRoot();
  if (action === "list" || action === "usage") return cmdList(["--json", "--provider", "agy"].concat(asJson ? ["--json"] : []), "agy");
  if (action === "status") {
    const payload = agyAccountsPayload(root);
    const activeEntry = payload.accounts.find((a) => a.active);
    if (asJson) {
      return emitJson({
        provider: "agy",
        activeAccountNumber: payload.active === null ? null : Number(payload.active),
        email: activeEntry?.email ?? null,
      });
    }
    for (const line of renderAccountsHuman("agy", payload.accounts)) console.log(line);
    return 0;
  }
  if (action === "remove") {
    const [target] = positionals(rest);
    if (!target) return fail("Usage: ccswap agy remove NUM|EMAIL [--yes]", asJson, 2);
    return settleSyncStdout(agyRemove(root, target, hasFlag(argv, "--yes")), originalArgv, asJson);
  }
  const fb = runPythonFallback(originalArgv);
  return fb.status ?? 1;
}

// ---- vendor tools (muse/kiro/grok) --------------------------------------------------

async function cmdVendorTool(tool: string, argv: string[], originalArgv: string[]): Promise<number> {
  const [action, ...rest] = argv;
  const asJson = hasFlag(argv, "--json");
  const root = backupRoot();
  if (action === "list" || action === "accounts") return cmdVendorList(tool, argv);
  if (action === "status") return cmdVendorStatus(tool, argv);
  if (action === "usage") {
    const account = positionals(rest)[0];
    if (hasFlag(argv, "--refresh")) {
      const res = await refreshUsage(root, [tool], { check: false });
      const out = settle(res, originalArgv, asJson);
      return typeof out === "number" ? out : 0;
    }
    // Cached usage (single account or all).
    const cache = loadVendorUsage(root);
    const { doc } = loadVendorsDoc(root);
    const accounts = toolAccounts(doc, tool).filter((a) => !account || a.alias === account);
    if (account && accounts.length === 0) return fail(`Unknown account '${account}'`, asJson);
    return emitJson({
      schemaVersion: 1,
      tool,
      liveRefresh: false,
      accounts: accounts.map((a) => {
        const cached = vendorUsageFor(cache, tool, a.alias);
        if (cached === null) return { alias: a.alias, state: "unknown", reason: "no cached reading" };
        return { alias: a.alias, ...cached };
      }),
    });
  }
  if (action === "add") {
    const [alias] = positionals(rest, ["--provider", "--account", "--from-file", "--identity-provider", "--region", "--profile-arn", "--profile-name"]);
    if (!alias) return fail(`Usage: ccswap ${tool} add ALIAS [...]`, asJson, 2);
    let secretStdin: string | null = null;
    if (hasFlag(argv, "--api-key-stdin")) {
      try {
        secretStdin = fs.readFileSync(0, "utf-8").split("\n")[0] ?? "";
      } catch {
        secretStdin = "";
      }
    }
    const res = vendorAdd(root, tool, alias, {
      provider: flagValue(argv, "--provider") ?? undefined,
      secretStdin,
      fromFile: flagValue(argv, "--from-file") ?? undefined,
      browser: hasFlag(argv, "--browser"),
      social: flagValue(argv, "--social") ?? undefined,
      license: flagValue(argv, "--license") ?? undefined,
      yes: hasFlag(argv, "--yes"),
    });
    return settleSyncStdout(res, originalArgv, asJson);
  }
  if (action === "remove") {
    const [target] = positionals(rest, ["--provider"]);
    if (!target) return fail(`Usage: ccswap ${tool} remove ALIAS [--json]`, asJson, 2);
    const res = vendorRemove(root, tool, target, flagValue(argv, "--provider") ?? undefined);
    return settleSyncStdout(res, originalArgv, asJson);
  }
  if (action === "switch") {
    const [target] = positionals(rest, ["--provider"]);
    if (!target) return fail(`Usage: ccswap ${tool} switch ALIAS [--yes]`, asJson, 2);
    return settle(await vendorSwitch(root, tool, target, {
      provider: flagValue(argv, "--provider") ?? undefined,
      yes: hasFlag(argv, "--yes"),
      login: hasFlag(argv, "--login"),
    }), originalArgv, asJson);
  }
  if (action === "run") {
    const separator = rest.indexOf("--");
    const before = separator < 0 ? rest : rest.slice(0, separator);
    const childArgs = separator < 0 ? [] : rest.slice(separator + 1);
    const [target] = positionals(before);
    if (tool !== "muse" || !target || before.length !== 1 || (separator < 0 && rest.length !== 1)) {
      const fb = runPythonFallback(originalArgv);
      return fb.status ?? 1;
    }
    const res = await vendorRun(root, tool, target, childArgs);
    if (!res.handled) {
      const fb = runPythonFallback(originalArgv);
      return fb.status ?? 1;
    }
    return settle(res, originalArgv, asJson);
  }
  const fb = runPythonFallback(originalArgv);
  return fb.status ?? 1;
}

export async function run(argv: string[]): Promise<number> {
  const originalArgv = [...argv];
  // `claude <verb>` rewrites to the top-level spelling first (Python
  // `claude_argv` parity). Unknown verbs fall back so Python prints the
  // exit-2 hint.
  if (argv[0] === "claude") {
    const rewritten = claudeRewritten(argv);
    if (rewritten === null) {
      const res = runPythonFallback(argv);
      return res.status ?? 1;
    }
    return run(rewritten);
  }
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
  if (first === "statusline") return cmdStatusline(argv);
  if (first === "switch" || first === "--switch" || first === "--switch-to") {
    if (first === "--switch-to") {
      const target = second;
      if (!target) return fail("Usage: ccswap switch NUM|EMAIL [--json]", hasFlag(argv, "--json"), 2);
      const res = switchAccount(backupRoot(), target, { json: hasFlag(argv, "--json"), force: hasFlag(argv, "--force") });
      return settleSyncStdout(res, originalArgv, hasFlag(argv, "--json"));
    }
    return cmdSwitch(argv, originalArgv);
  }
  if (first === "--add-account" || first === "add") {
    // `add` with a token positional is add-token's spelling.
    const rest = positionals(argv.slice(1), ["--slot", "--alias", "--email"]);
    if (first === "add" && rest.length > 0 && second !== undefined && !second.startsWith("--")) {
      return cmdAddToken(argv, originalArgv);
    }
    return cmdAdd(argv, originalArgv);
  }
  if (first === "add-token" || first === "--add-token") return cmdAddToken(argv, originalArgv);
  if (first === "--remove-account" || first === "remove" || first === "rm") {
    const id = first === "--remove-account" ? second : second;
    if (id === undefined || id.startsWith("--")) {
      return fail("Usage: ccswap remove NUM|EMAIL [--yes]", hasFlag(argv, "--json"), 2);
    }
    return settleSyncStdout(removeAccount(backupRoot(), id, hasFlag(argv, "--yes")), originalArgv, hasFlag(argv, "--json"));
  }
  if (first === "--disable-account" || first === "disable") {
    const id = first === "--disable-account" ? second : second;
    if (id === undefined) return fail("Usage: ccswap disable NUM|EMAIL", hasFlag(argv, "--json"), 2);
    return settleSyncStdout(disableAccount(backupRoot(), id), originalArgv, hasFlag(argv, "--json"));
  }
  if (first === "--enable-account" || first === "enable") {
    const id = first === "--enable-account" ? second : second;
    if (id === undefined) return fail("Usage: ccswap enable NUM|EMAIL", hasFlag(argv, "--json"), 2);
    return settleSyncStdout(enableAccount(backupRoot(), id), originalArgv, hasFlag(argv, "--json"));
  }
  if (first === "codex") return cmdCodex(argv.slice(1), originalArgv);
  if (first === "agy") return cmdAgy(argv.slice(1), originalArgv);
  if (first !== undefined && (VENDOR_TOOLS as readonly string[]).includes(first)) {
    return cmdVendorTool(first, argv.slice(1), originalArgv);
  }
  if (first === "grok") return cmdVendorTool(first, argv.slice(1), originalArgv);
  if (first === "vendors" || first === "tools") return cmdVendors(argv.slice(1));
  if (first === "usage") return cmdUsage(argv.slice(1), originalArgv);
  if (first === "config") return cmdConfig(argv.slice(1), originalArgv);
  if (first === "alias") return cmdAlias(argv, originalArgv);
  if (first === "map") return cmdMap(argv, originalArgv);
  if (first === "unmap") return cmdUnmap(argv, originalArgv);
  if (first === "unclaimed") return cmdUnclaimed(argv, originalArgv);
  if (first === "swap") return cmdSwap(argv, originalArgv);
  if (first === "move") return cmdMove(argv, originalArgv);
  if (first === "export" || first === "--export") return cmdExport(argv.slice(1), originalArgv);
  if (first === "import" || first === "--import") return cmdImport(argv.slice(1), originalArgv);
  if (first === "import-usage" || first === "--import-usage") return cmdImportUsage(argv.slice(1), originalArgv);
  if (first === "overview") {
    const asJson = hasFlag(argv, "--json");
    if (!asJson) return fail("overview needs --json", false, 2);
    return emitJson(collectOverview(backupRoot()));
  }
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
  run(argv).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(`Error: ${err instanceof Error ? err.message : "unknown error"}`);
      process.exit(1);
    },
  );
}

// Auto-run only when invoked as the CLI entry (bundle or tsx/node), never
// when imported (e.g. by vitest).
const invokedAsCli =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("main.ts") || process.argv[1].endsWith("ccswap.mjs"));
if (invokedAsCli) main();
