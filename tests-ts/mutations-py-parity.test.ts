/**
 * Mutation parity against the real Python CLI (gated).
 *
 * Runs only with `CCSWAP_RUN_PY_PARITY=1` and a working Python toolchain
 * (`$CCSWAP_PY_BIN`, default `python3`, with ccswap's deps importable and
 * `PYTHONPATH` pointing at the repo's `src/`). Each case replays one argv on
 * two identical fixture copies — once through TS `run()`, once through the
 * Python CLI — and compares the resulting state files modulo volatile fields
 * (timestamps) and random secret refs.
 *
 * Skipped by default: this environment has no Python deps and no network to
 * install them (crew policy). CI runs it.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { run } from "../src-ts/main.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..");
const fixtureHome = path.join(here, "fixtures", "basic", "home");
const fixtureBin = path.join(here, "fixtures", "basic", "bin");

const enabled = process.env["CCSWAP_RUN_PY_PARITY"] === "1";

function stripVolatile(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripVolatile);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (["lastUpdated", "added", "exportedAt", "fetchedAt", "observedAt"].includes(key)) {
        continue;
      }
      out[key] = key === "secretRef" && typeof entry === "string" ? "<ref>" : stripVolatile(entry);
    }
    return out;
  }
  return value;
}

function snapshot(backup: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const rel of ["sequence.json", "mappings.json", "settings.json", "vendors/vendors.json", "codex/sequence.json", "agy/accounts.json", "cache/usage.json"]) {
    const file = path.join(backup, rel);
    try {
      out[rel] = stripVolatile(JSON.parse(fs.readFileSync(file, "utf-8")) as unknown);
    } catch {
      out[rel] = "<missing>";
    }
  }
  // Secret contents (sorted) — names are random, contents must match.
  try {
    const dir = path.join(backup, "vendors", "secrets");
    out["secrets"] = fs
      .readdirSync(dir)
      .filter((n) => n.endsWith(".secret"))
      .map((n) => fs.readFileSync(path.join(dir, n), "utf-8"))
      .sort();
  } catch {
    out["secrets"] = [];
  }
  // Credential blobs decoded (base64) so encoding parity is compared, not bytes.
  const creds: Record<string, string> = {};
  try {
    const dir = path.join(backup, "credentials");
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".enc")) continue;
      const text = fs.readFileSync(path.join(dir, name), "utf-8").trim();
      try {
        creds[name] = text.startsWith("{") ? text : Buffer.from(text, "base64").toString("utf-8");
      } catch {
        creds[name] = `<undecodable:${text.slice(0, 20)}>`;
      }
    }
  } catch {
    // No credentials dir.
  }
  out["credentials"] = creds;
  return out;
}

async function runTs(home: string, argv: string[]): Promise<number> {
  process.env["HOME"] = home;
  process.env["CCSWAP_BACKUP_ROOT"] = path.join(home, ".claude-swap-backup");
  delete process.env["CLAUDE_CONFIG_DIR"];
  process.env["CODEX_HOME"] = path.join(home, ".codex");
  const quiet = { log: console.log, error: console.error };
  console.log = () => undefined;
  console.error = () => undefined;
  try {
    return await run(argv);
  } finally {
    console.log = quiet.log;
    console.error = quiet.error;
  }
}

function runPy(home: string, argv: string[], stdin?: string): number {
  const bin = process.env["CCSWAP_PY_BIN"] ?? "python3";
  const res = spawnSync(bin, ["-m", "claude_swap", ...argv], {
    input: stdin,
    encoding: "utf-8",
    env: {
      ...process.env,
      HOME: home,
      PYTHONPATH: path.join(repo, "src"),
      PATH: `${fixtureBin}${path.delimiter}${process.env["PATH"] ?? ""}`,
    },
  });
  if (res.error) throw res.error;
  return res.status ?? 99;
}

describe.skipIf(!enabled)("mutation parity vs Python CLI", () => {
  beforeAll(() => {
    process.env["PATH"] = `${fixtureBin}${path.delimiter}${process.env["PATH"] ?? ""}`;
  });

  const cases: Array<{ name: string; steps: Array<{ argv: string[]; stdin?: string }> }> = [
    { name: "alias", steps: [{ argv: ["alias", "2", "bobby"] }, { argv: ["alias", "2", "--unset"] }] },
    { name: "disable-enable", steps: [{ argv: ["disable", "2"] }, { argv: ["enable", "2"] }] },
    { name: "swap", steps: [{ argv: ["swap", "1", "2"] }, { argv: ["swap", "1", "2"] }] },
    { name: "move", steps: [{ argv: ["move", "2", "5"] }, { argv: ["move", "5", "2"] }] },
    { name: "config", steps: [{ argv: ["config", "set", "ui.theme", "light"] }, { argv: ["config", "unset", "ui.theme"] }] },
    { name: "map", steps: [{ argv: ["map", "2", "/tmp/x"] }, { argv: ["unmap", "/tmp/x"] }] },
    { name: "add-remove", steps: [{ argv: ["add-token", "sk-ant-parity-key", "--email", "parity@example.com"] }, { argv: ["remove", "3", "--yes"] }] },
    { name: "codex-remove", steps: [{ argv: ["codex", "remove", "1", "--yes"] }] },
    { name: "agy-remove", steps: [{ argv: ["agy", "remove", "1", "--yes"] }] },
    {
      name: "vendor-add-remove",
      steps: [{ argv: ["muse", "add", "parity", "--api-key-stdin"], stdin: "sk-ant-parity\n" }, { argv: ["muse", "remove", "parity"] }],
    },
  ];

  for (const c of cases) {
    it(`${c.name} leaves identical state`, async () => {
      const tsHome = fs.mkdtempSync(path.join(os.tmpdir(), "ccswap-pts-"));
      const pyHome = fs.mkdtempSync(path.join(os.tmpdir(), "ccswap-ppy-"));
      try {
        fs.cpSync(fixtureHome, tsHome, { recursive: true });
        fs.cpSync(fixtureHome, pyHome, { recursive: true });
        for (const step of c.steps) {
          const tsCode = await runTs(tsHome, step.argv);
          const pyCode = runPy(pyHome, step.argv, step.stdin);
          expect({ step: step.argv.join(" "), tsCode }).toEqual({ step: step.argv.join(" "), tsCode: pyCode });
        }
        expect(snapshot(path.join(tsHome, ".claude-swap-backup"))).toEqual(
          snapshot(path.join(pyHome, ".claude-swap-backup")),
        );
      } finally {
        fs.rmSync(tsHome, { recursive: true, force: true });
        fs.rmSync(pyHome, { recursive: true, force: true });
      }
    });
  }
});
