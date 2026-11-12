/**
 * Wave-2 mutation tests: TS use-cases against per-test copies of the basic
 * fixture — never the checked-in fixture, never the real home.
 *
 * A stub `$CCSWAP_PYTHON_CLI` records fallback argv and exits 3, so no test
 * can spawn the real Python CLI (which needs network-installed deps) and the
 * TS→Python fallback wiring is itself asserted. Python-oracle parity lives
 * in `mutations-py-parity.test.ts` (gated on `CCSWAP_RUN_PY_PARITY`).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { run } from "../src-ts/main.js";
import { readJsonFile } from "../src-ts/platform/domain/jsonFile.js";
import {
  addToken,
  aliasSet,
  moveAccount,
  switchAccount,
  swapAccounts,
} from "../src-ts/accounts/application/manageAccounts.js";
import { vendorAdd, vendorRemove } from "../src-ts/vendors/application/manageVendors.js";
import { configSet, configUnset } from "../src-ts/config/application/writeSettings.js";
import { mapAccount } from "../src-ts/mappings/application/manageMappings.js";
import { collectOverview, collectStatusline } from "../src-ts/overview/application/collect.js";
import { SETTING_SPECS } from "../src-ts/config/domain/settings.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureHome = path.join(here, "fixtures", "basic", "home");
const fixtureBin = path.join(here, "fixtures", "basic", "bin");

const savedEnv: Record<string, string | undefined> = {};
for (const key of [
  "HOME",
  "CCSWAP_BACKUP_ROOT",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "CCSWAP_PYTHON_CLI",
  "PATH",
  "CCSWAP_SESSION",
  "CCSWAP_SESSION_SHELL",
  "META_API_KEY",
  "KIRO_API_KEY",
  "MUSE_CHILD",
  "CHILD_LOG",
]) {
  savedEnv[key] = process.env[key];
}

let stubOut = "";
let home = "";
let root = "";

async function runTs(argv: string[]): Promise<{ code: number; stdout: string }> {
  const lines: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  let code = 0;
  try {
    code = await run(argv);
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return { code, stdout: `${lines.join("\n")}\n` };
}

function stubArgv(): string {
  try {
    return fs.readFileSync(stubOut, "utf-8").trim();
  } catch {
    return "";
  }
}

function roster(): Record<string, { email: string; alias?: string; disabled?: boolean }> {
  const doc = readJsonFile(path.join(root, "sequence.json")) as {
    accounts: Record<string, { email: string; alias?: string; disabled?: boolean }>;
  };
  return doc.accounts;
}

function activeNumber(): unknown {
  const doc = readJsonFile(path.join(root, "sequence.json")) as { activeAccountNumber: unknown };
  return doc.activeAccountNumber;
}

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccswap-stub-"));
  stubOut = path.join(dir, "argv.log");
  const stub = path.join(dir, "ccswap-stub");
  fs.writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${stubOut}"\nexit 3\n`, {
    mode: 0o755,
  });
  process.env["CCSWAP_PYTHON_CLI"] = stub;
  process.env["PATH"] = `${fixtureBin}${path.delimiter}${process.env["PATH"] ?? ""}`;
  delete process.env["CCSWAP_SESSION"];
  delete process.env["CCSWAP_SESSION_SHELL"];
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
});

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccswap-mut-"));
  fs.cpSync(fixtureHome, dir, { recursive: true });
  home = dir;
  root = path.join(dir, ".claude-swap-backup");
  process.env["HOME"] = dir;
  process.env["CCSWAP_BACKUP_ROOT"] = root;
  // No CLAUDE_CONFIG_DIR: live files resolve under the fake HOME exactly
  // like production (`~/.claude/.credentials.json`, `~/.claude.json`).
  delete process.env["CLAUDE_CONFIG_DIR"];
  process.env["CODEX_HOME"] = path.join(dir, ".codex");
  try {
    fs.unlinkSync(stubOut);
  } catch {
    // First test: no stub output yet.
  }
  return () => {
    fs.rmSync(dir, { recursive: true, force: true });
  };
});

describe("alias / disable / enable", () => {
  it("sets and unsets an alias", async () => {
    let res = await runTs(["alias", "2", "bobby"]);
    expect(res.code).toBe(0);
    expect(roster()["2"]?.alias).toBe("bobby");
    res = await runTs(["alias", "2", "--unset"]);
    expect(res.code).toBe(0);
    expect(roster()["2"]?.alias).toBeUndefined();
  });

  it("refuses an alias owned by another slot", async () => {
    const res = await runTs(["alias", "2", "dev"]);
    expect(res.code).toBe(1);
    expect(res.stdout).toMatch(/already used/);
    expect(roster()["2"]?.alias).toBeUndefined();
  });

  it("disables and re-enables an account", async () => {
    expect((await runTs(["disable", "2"])).code).toBe(0);
    expect(roster()["2"]?.disabled).toBe(true);
    expect((await runTs(["enable", "2"])).code).toBe(0);
    expect(roster()["2"]?.disabled).toBe(false);
  });

  it("rolls an alias write back to identical bytes", () => {
    const file = path.join(root, "sequence.json");
    const before = fs.readFileSync(file);
    const res = aliasSet(root, "2", "bobby");
    expect(res.code).toBe(0);
    expect(res.reverse.size).toBeGreaterThan(0);
    res.reverse.rollback();
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });
});

function seedTokenAccount(slot: string, email: string, key: string): void {
  const credDir = path.join(root, "credentials");
  const cfgDir = path.join(root, "configs");
  fs.mkdirSync(credDir, { recursive: true });
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(
    path.join(credDir, `.creds-${slot}-${email}.enc`),
    Buffer.from(key, "utf-8").toString("base64"),
  );
  fs.writeFileSync(
    path.join(cfgDir, `.claude-config-${slot}-${email}.json`),
    JSON.stringify({ oauthAccount: { emailAddress: email } }),
  );
}

function readBackupDecoded(slot: string, email: string): string | null {
  try {
    const text = fs.readFileSync(path.join(root, "credentials", `.creds-${slot}-${email}.enc`), "utf-8").trim();
    if (text.startsWith("{")) return text;
    return Buffer.from(text, "base64").toString("utf-8");
  } catch {
    return null;
  }
}

describe("swap / move migrate file backups", () => {
  it("swap exchanges roster rows and follows credentials", async () => {
    expect((await runTs(["add-token", "sk-ant-alice-key", "--email", "alice@example.com", "--slot", "1", "--yes"])).code).toBe(0);
    expect((await runTs(["add-token", "sk-ant-bob-key", "--email", "bob@example.com", "--slot", "2", "--yes"])).code).toBe(0);
    const res = await runTs(["swap", "1", "2"]);
    expect(res.code).toBe(0);
    expect(roster()["1"]?.email).toBe("bob@example.com");
    expect(roster()["2"]?.email).toBe("alice@example.com");
    // Credentials followed the account, stale keys are gone.
    expect(readBackupDecoded("1", "bob@example.com")).toBe("sk-ant-bob-key");
    expect(readBackupDecoded("2", "alice@example.com")).toBe("sk-ant-alice-key");
    expect(readBackupDecoded("1", "alice@example.com")).toBeNull();
    expect(readBackupDecoded("2", "bob@example.com")).toBeNull();
  });

  it("swap rolls back roster and backups together", async () => {
    await runTs(["add-token", "sk-ant-alice-key", "--email", "alice@example.com", "--slot", "1", "--yes"]);
    await runTs(["add-token", "sk-ant-bob-key", "--email", "bob@example.com", "--slot", "2", "--yes"]);
    const snapshot = new Map<string, Buffer | null>();
    for (const f of ["sequence.json", "credentials/.creds-1-alice@example.com.enc", "credentials/.creds-2-bob@example.com.enc"]) {
      const p = path.join(root, f);
      snapshot.set(f, fs.existsSync(p) ? fs.readFileSync(p) : null);
    }
    const res = swapAccounts(root, "1", "2");
    expect(res.code).toBe(0);
    res.reverse.rollback();
    for (const [f, bytes] of snapshot) {
      const p = path.join(root, f);
      if (bytes === null) expect(fs.existsSync(p)).toBe(false);
      else expect(fs.readFileSync(p).equals(bytes)).toBe(true);
    }
    // Cross-written keys are removed again by the rollback.
    expect(fs.existsSync(path.join(root, "credentials", ".creds-1-bob@example.com.enc"))).toBe(false);
    expect(fs.existsSync(path.join(root, "credentials", ".creds-2-alice@example.com.enc"))).toBe(false);
  });

  it("move relocates material and clears the stale key", async () => {
    await runTs(["add-token", "sk-ant-bob-key", "--email", "bob@example.com", "--slot", "2", "--yes"]);
    const res = await runTs(["move", "2", "5"]);
    expect(res.code).toBe(0);
    expect(roster()["5"]?.email).toBe("bob@example.com");
    expect(roster()["2"]).toBeUndefined();
    expect(readBackupDecoded("5", "bob@example.com")).toBe("sk-ant-bob-key");
    expect(readBackupDecoded("2", "bob@example.com")).toBeNull();
  });

  it("move onto an occupied slot swaps with backup migration", async () => {
    await runTs(["add-token", "sk-ant-alice-key", "--email", "alice@example.com", "--slot", "1", "--yes"]);
    await runTs(["add-token", "sk-ant-bob-key", "--email", "bob@example.com", "--slot", "2", "--yes"]);
    const res = await runTs(["move", "2", "1"]);
    expect(res.code).toBe(0);
    expect(roster()["1"]?.email).toBe("bob@example.com");
    expect(readBackupDecoded("1", "bob@example.com")).toBe("sk-ant-bob-key");
    expect(readBackupDecoded("2", "alice@example.com")).toBe("sk-ant-alice-key");
  });

  it("move rolls back to identical state", () => {
    // Slot 2 is fixture bob; seed file backups, move, then roll everything back.
    seedTokenAccount("2", "bob@example.com", "sk-ant-bob-key");
    const res = moveAccount(root, "2", "5");
    expect(res.code).toBe(0);
    expect(roster()["5"]?.email).toBe("bob@example.com");
    res.reverse.rollback();
    expect(roster()["5"]).toBeUndefined();
    expect(roster()["2"]?.email).toBe("bob@example.com");
    expect(readBackupDecoded("2", "bob@example.com")).toBe("sk-ant-bob-key");
    expect(readBackupDecoded("5", "bob@example.com")).toBeNull();
  });

  it("rejects self-swap and bad slots without touching state", async () => {
    const before = fs.readFileSync(path.join(root, "sequence.json"));
    expect((await runTs(["swap", "1", "1"])).code).toBe(1);
    expect((await runTs(["move", "1", "0"])).code).toBe(1);
    expect(fs.readFileSync(path.join(root, "sequence.json")).equals(before)).toBe(true);
  });
});

describe("add-token / remove", () => {
  it("adds an api key and removes it with --yes", async () => {
    expect((await runTs(["add-token", "sk-ant-temp-key", "--email", "temp@example.com"])).code).toBe(0);
    expect(roster()["3"]?.email).toBe("temp@example.com");
    expect(readBackupDecoded("3", "temp@example.com")).toBe("sk-ant-temp-key");
    const res = await runTs(["remove", "3", "--yes"]);
    expect(res.code).toBe(0);
    expect(roster()["3"]).toBeUndefined();
    expect(readBackupDecoded("3", "temp@example.com")).toBeNull();
  });

  it("remove without --yes falls back to Python with identical argv", async () => {
    const before = fs.readFileSync(path.join(root, "sequence.json"));
    const res = await runTs(["remove", "2"]);
    expect(res.code).toBe(3);
    expect(stubArgv()).toBe("remove 2");
    expect(fs.readFileSync(path.join(root, "sequence.json")).equals(before)).toBe(true);
  });

  it("rejects empty tokens and bad emails", async () => {
    // Direct call: the CLI spelling would read stdin for an empty token.
    expect(addToken(root, "   ", { email: "x@example.com" }).code).toBe(1);
    expect((await runTs(["add-token", "tok", "--email", "not-an-email"])).code).toBe(1);
    expect(roster()["3"]).toBeUndefined();
  });
});

function seedLiveLogin(email: string, orgUuid: string, accountUuid: string): string {
  const liveCreds = JSON.stringify({
    claudeAiOauth: { refreshToken: `r-${email}`, accessToken: `a-${email}`, expiresAt: 9999999999, scopes: ["user:inference"] },
  });
  const claudeDir = path.join(home, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, ".credentials.json"), liveCreds);
  const globalPath = path.join(home, ".claude.json");
  const global = JSON.parse(fs.readFileSync(globalPath, "utf-8")) as Record<string, unknown>;
  global["oauthAccount"] = { emailAddress: email, organizationUuid: orgUuid, accountUuid };
  fs.writeFileSync(globalPath, JSON.stringify(global, null, 2));
  return liveCreds;
}

describe("switch", () => {
  it("switches to a file-backed slot and backs up the displaced login", async () => {
    const liveCreds = seedLiveLogin("alice@example.com", "org-1", "u-alice");
    seedTokenAccount("1", "alice@example.com", liveCreds);
    const bobCreds = JSON.stringify({
      claudeAiOauth: { refreshToken: "r-bob", accessToken: "a-bob", expiresAt: 9999999999, scopes: ["user:inference"] },
    });
    seedTokenAccount("2", "bob@example.com", bobCreds);
    const res = await runTs(["switch", "2"]);
    expect(res.code).toBe(0);
    expect(activeNumber()).toBe(2);
    // Live files now carry bob; alice's displaced login was backed up to slot 1.
    expect(fs.readFileSync(path.join(home, ".claude", ".credentials.json"), "utf-8")).toBe(bobCreds);
    expect(readBackupDecoded("1", "alice@example.com")).toBe(liveCreds);
  });

  it("switch rolls back live files and roster together", () => {
    const liveCreds = seedLiveLogin("alice@example.com", "org-1", "u-alice");
    seedTokenAccount("1", "alice@example.com", liveCreds);
    seedTokenAccount("2", "bob@example.com", "raw-bob-creds");
    const liveFile = path.join(home, ".claude", ".credentials.json");
    const beforeLive = fs.readFileSync(liveFile);
    const res = switchAccount(root, "2", {});
    expect(res.code).toBe(0);
    res.reverse.rollback();
    expect(activeNumber()).toBe(1);
    expect(fs.readFileSync(liveFile).equals(beforeLive)).toBe(true);
    expect(readBackupDecoded("1", "alice@example.com")).toBe(liveCreds);
    expect(readBackupDecoded("2", "bob@example.com")).toBe("raw-bob-creds");
  });

  it("falls back when the target backup is keychain-only", async () => {
    seedLiveLogin("alice@example.com", "org-1", "u-alice");
    const res = await runTs(["switch", "2"]);
    expect(res.code).toBe(3);
    expect(stubArgv()).toBe("switch 2");
    expect(activeNumber()).toBe(1);
  });

  it("bare switch rotates to the next enabled account", async () => {
    const liveCreds = seedLiveLogin("alice@example.com", "org-1", "u-alice");
    seedTokenAccount("1", "alice@example.com", liveCreds);
    seedTokenAccount("2", "bob@example.com", "raw-bob-creds");
    expect((await runTs(["switch"])).code).toBe(0);
    expect(activeNumber()).toBe(2);
  });
});

describe("config set / unset", () => {
  it("round-trips a value through settings.json", async () => {
    expect((await runTs(["config", "set", "ui.theme", "light"])).code).toBe(0);
    const doc = readJsonFile(path.join(root, "settings.json")) as { ui: { theme: string } };
    expect(doc.ui.theme).toBe("light");
    expect((await runTs(["config", "unset", "ui.theme"])).code).toBe(0);
    const doc2 = readJsonFile(path.join(root, "settings.json")) as Record<string, unknown>;
    expect(doc2["ui"]).toBeUndefined();
  });

  it("rejects unknown keys and bad values without writing", async () => {
    const before = fs.readFileSync(path.join(root, "settings.json"));
    expect((await runTs(["config", "set", "nope.nope", "1"])).code).toBe(2);
    expect((await runTs(["config", "set", "ui.theme", "neon"])).code).toBe(1);
    expect((await runTs(["config", "set", "autoswitch.threshold", "500"])).code).toBe(1);
    expect(fs.readFileSync(path.join(root, "settings.json")).equals(before)).toBe(true);
  });

  it("rolls a set back to identical bytes", () => {
    const file = path.join(root, "settings.json");
    const before = fs.readFileSync(file);
    const res = configSet(root, "autoswitch.threshold", "80");
    expect(res.code).toBe(0);
    res.reverse.rollback();
    expect(fs.readFileSync(file).equals(before)).toBe(true);
    expect(configUnset(root, "updates.check").code).toBe(0);
  });
});

describe("map / unmap", () => {
  it("maps a directory by identity and unmaps it", async () => {
    const dir = "/tmp/ccswap-test-map-dir";
    expect((await runTs(["map", "2", dir])).code).toBe(0);
    const doc = readJsonFile(path.join(root, "mappings.json")) as {
      mappings: Record<string, { email: string; organizationUuid: string }>;
    };
    expect(doc.mappings[dir]?.email).toBe("bob@example.com");
    expect((await runTs(["unmap", dir])).code).toBe(0);
    const doc2 = readJsonFile(path.join(root, "mappings.json")) as {
      mappings: Record<string, object>;
    };
    expect(doc2.mappings[dir]).toBeUndefined();
  });

  it("rolls a mapping back and reports reverse size", () => {
    const file = path.join(root, "mappings.json");
    const before = fs.readFileSync(file);
    const res = mapAccount(root, "1", "/tmp/ccswap-rollback-dir");
    expect(res.code).toBe(0);
    expect(res.reverse.size).toBeGreaterThan(0);
    res.reverse.rollback();
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });
});

describe("vendor add / remove", () => {
  it("runs Muse with isolated API-key environment and forwarded argv", async () => {
    const child = path.join(home, "child");
    fs.writeFileSync(child, `#!/bin/sh\nprintf '%s\\n' "$*|$META_API_KEY|$TBH_CREDENTIAL_BACKEND|${"${KIRO_API_KEY-}"}" > "$CHILD_LOG"\nexit 7\n`, { mode: 0o755 });
    const log = path.join(home, "child.log");
    process.env["PATH"] = `${home}${path.delimiter}${process.env["PATH"] ?? ""}`;
    process.env["MUSE_CHILD"] = child;
    process.env["CHILD_LOG"] = log;
    process.env["META_API_KEY"] = "ambient";
    const result = await runTs(["muse", "run", "work", "--", "exec", "hi"]);
    expect(result.code).toBe(7);
    expect(fs.readFileSync(log, "utf8").trim()).toBe("exec hi|fake-secret-for-fixture-only|file|");
  });

  it("falls back to Python with the original argv when Muse cannot spawn", async () => {
    process.env["MUSE_CHILD"] = path.join(home, "missing-muse");
    const result = await runTs(["muse", "run", "work", "--", "exec", "hi"]);
    expect(result.code).toBe(3);
    expect(stubArgv()).toBe("muse run work -- exec hi");
  });

  it("registers an api-key account with a 0600 secret file", () => {
    const res = vendorAdd(root, "muse", "second", { secretStdin: "sk-ant-second-key" });
    expect(res.code).toBe(0);
    const doc = readJsonFile(path.join(root, "vendors", "vendors.json")) as {
      tools: Record<string, { accounts: Array<{ alias: string; secretRef: string | null }> }>;
    };
    const rec = doc.tools["muse"]?.accounts.find((a) => a.alias === "second");
    const ref = rec?.secretRef;
    if (typeof ref !== "string") throw new Error("vendor add did not return a secret ref");
    expect(ref).toMatch(/^muse-[0-9a-f]{32}$/);
    expect(ref).not.toContain("second");
    const secretFile = path.join(root, "vendors", "secrets", `${ref}.secret`);
    expect(fs.readFileSync(secretFile, "utf-8")).toBe("sk-ant-second-key\n");
    expect(fs.statSync(secretFile).mode & 0o777).toBe(0o600);
  });

  it("refuses api-key registration without a secret", () => {
    expect(vendorAdd(root, "muse", "nosecret", {}).code).toBe(1);
  });

  it("removes a registration and drops its secret, with rollback", () => {
    vendorAdd(root, "muse", "ephemeral", { secretStdin: "sk-ant-ephemeral" });
    const docFile = path.join(root, "vendors", "vendors.json");
    const before = fs.readFileSync(docFile);
    const secretsBefore = new Set(fs.readdirSync(path.join(root, "vendors", "secrets")));
    const res = vendorRemove(root, "muse", "ephemeral");
    expect(res.code).toBe(0);
    const secretsAfter = new Set(fs.readdirSync(path.join(root, "vendors", "secrets")));
    expect(secretsAfter.size).toBe(secretsBefore.size - 1);
    res.reverse.rollback();
    expect(fs.readFileSync(docFile).equals(before)).toBe(true);
    expect(new Set(fs.readdirSync(path.join(root, "vendors", "secrets")))).toEqual(secretsBefore);
  });

  it("answers grok verbs as known-but-unsupported", async () => {
    expect((await runTs(["grok", "list", "--json"])).code).toBe(0);
    const add = vendorAdd(root, "grok", "g1", {});
    expect(add.code).toBe(3);
  });
});

describe("codex / agy remove", () => {
  it("removes a codex account with --yes", async () => {
    const res = await runTs(["codex", "remove", "1", "--yes"]);
    expect(res.code).toBe(0);
    const seq = readJsonFile(path.join(root, "codex", "sequence.json")) as {
      accounts: Record<string, object>;
    };
    expect(seq.accounts["1"]).toBeUndefined();
  });

  it("codex remove without --yes falls back with identical argv", async () => {
    const res = await runTs(["codex", "remove", "1"]);
    expect(res.code).toBe(3);
    expect(stubArgv()).toBe("codex remove 1");
  });

  it("removes an agy account with its sidecars", async () => {
    const res = await runTs(["agy", "remove", "1", "--yes"]);
    expect(res.code).toBe(0);
    const seq = readJsonFile(path.join(root, "agy", "accounts.json")) as {
      accounts: Record<string, object>;
    };
    expect(seq.accounts["1"]).toBeUndefined();
    expect(fs.existsSync(path.join(root, "agy", "account-1.json"))).toBe(false);
    expect(fs.existsSync(path.join(root, "agy", "usage-1.json"))).toBe(false);
  });
});

describe("export / import round-trip", () => {
  it("exports, removes, and re-imports an account byte-identically", async () => {
    expect((await runTs(["add-token", "sk-ant-round-key", "--email", "round@example.com"])).code).toBe(0);
    const dest = path.join(home, "export.json");
    expect((await runTs(["export", dest, "--account", "3"])).code).toBe(0);
    const envelope = JSON.parse(fs.readFileSync(dest, "utf-8")) as {
      version: number;
      accounts: Array<{ email: string; credentials: string; kind?: string }>;
    };
    expect(envelope.version).toBe(1);
    expect(envelope.accounts[0]?.email).toBe("round@example.com");
    expect(envelope.accounts[0]?.credentials).toBe("sk-ant-round-key");
    expect((await runTs(["remove", "3", "--yes"])).code).toBe(0);
    expect(roster()["3"]).toBeUndefined();
    expect((await runTs(["import", dest])).code).toBe(0);
    expect(roster()["3"]?.email).toBe("round@example.com");
    // The re-imported backup decodes to the original key (base64 parity).
    expect(readBackupDecoded("3", "round@example.com")).toBe("sk-ant-round-key");
  });

  it("adopts fresh rows and keeps newer local readings", async () => {
    const cacheFile = path.join(root, "cache", "usage.json");
    const prevAlice = (
      readJsonFile(cacheFile) as { accounts: Record<string, { fetchedAt: number }> }
    ).accounts["1"]?.fetchedAt;
    const docPath = path.join(home, "usage-in.json");
    fs.writeFileSync(
      docPath,
      JSON.stringify({
        schemaVersion: 1,
        accounts: [
          // Bob has no cached row: adopted.
          {
            email: "bob@example.com",
            organizationUuid: "",
            usageStatus: "ok",
            usage: { windows: [{ usedPercent: 12 }] },
            usageAgeSeconds: 5,
          },
          // Alice's cached row is newer than this document: kept as-is.
          {
            email: "alice@example.com",
            organizationUuid: "org-1",
            usageStatus: "ok",
            usage: { windows: [{ usedPercent: 99 }] },
            usageAgeSeconds: 5,
          },
        ],
      }),
    );
    expect((await runTs(["import-usage", docPath])).code).toBe(0);
    const cache = readJsonFile(cacheFile) as {
      accounts: Record<string, { email: string; lastGood: unknown; lastError: null; fetchedAt: number }>;
    };
    expect(cache.accounts["2"]?.email).toBe("bob@example.com");
    expect(cache.accounts["2"]?.lastError).toBeNull();
    expect(cache.accounts["1"]?.fetchedAt).toBe(prevAlice);
  });
});

describe("usage refresh / check", () => {
  it("refreshes vendor tools with the failing probe degrading to stale rows", async () => {
    // Fixture vendor stubs fail: muse/opencode degrade to cached rows, never fatal.
    const res = await runTs(["usage", "muse", "opencode", "--refresh", "--json"]);
    expect(res.code).toBe(0);
    const payload = JSON.parse(res.stdout) as {
      liveRefresh: boolean;
      tools: Array<{ tool: string; accounts: Array<{ alias: string; state: string }> }>;
    };
    expect(payload.liveRefresh).toBe(true);
    const states = new Map(payload.tools.map((t) => [t.tool, t.accounts.map((a) => a.state)]));
    expect(states.get("muse")).toEqual(["stale"]);
    expect(states.get("opencode")).toEqual(["stale"]);
  });

  it("--check passes when every requested account shows a cached row", async () => {
    const res = await runTs(["usage", "muse", "--check", "--json"]);
    expect(res.code).toBe(0);
  });

  it("falls the whole command back when a tool needs the Python probe", async () => {
    // claude/codex/agy/kiro live probes stay in Python this wave.
    const res = await runTs(["usage", "--check"]);
    expect(res.code).toBe(3);
    expect(stubArgv()).toBe("usage --check");
  });

  it("rejects unknown tools without touching state", async () => {
    expect((await runTs(["usage", "nope", "--refresh"])).code).toBe(2);
  });
});

describe("overview / statusline backends", () => {
  it("collects one snapshot for every frontend", () => {
    const overview = collectOverview(root);
    expect(overview.schemaVersion).toBe(1);
    expect(overview.liveRefresh).toBe(false);
    expect(overview.claude.accounts).toHaveLength(2);
    const counts = new Map(overview.tools.map((t) => [t.tool, t.accounts]));
    expect(counts.get("claude")).toBe(2);
    expect(counts.get("codex")).toBe(1);
    expect(counts.get("agy")).toBe(1);
    expect(counts.get("muse")).toBe(1);
    expect(counts.get("opencode")).toBe(1);
    expect(counts.get("kiro")).toBe(0);
    expect(overview.vendors.vendors).toHaveLength(3);
    expect(overview.settings).toHaveLength(SETTING_SPECS.length);
  });

  it("serves overview --json through the CLI", async () => {
    const res = await runTs(["overview", "--json"]);
    expect(res.code).toBe(0);
    expect((JSON.parse(res.stdout) as { schemaVersion: number }).schemaVersion).toBe(1);
  });

  it("derives the statusline backend from local reads only", () => {
    const status = collectStatusline(root);
    expect(status.schemaVersion).toBe(1);
    // No live login in the fixture: no active account, best headroom by cache.
    expect(status.active).toBeNull();
    expect(status.managed).toBe(false);
    if (status.bestOther !== null) {
      expect(["1", "2"]).toContain(status.bestOther.slot);
    }
  });
});

describe("unclaimed", () => {
  it("lists nothing and purges unknown ids with an error", async () => {
    expect((await runTs(["unclaimed"])).code).toBe(0);
    expect((await runTs(["unclaimed", "--purge", "nope"])).code).toBe(1);
  });
});
