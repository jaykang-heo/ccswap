/**
 * Dispatcher: run ported read-only commands in TS, pass everything else to
 * the existing Python CLI unchanged (args and exit code preserved).
 * Porting cut: docs/migration/behavior-matrix.md § "Wave-1 porting cut".
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VENDOR_TOOLS = new Set(["muse", "opencode", "kiro"]);

export function isPorted(argv: string[]): boolean {
  const [first, second, ...rest] = argv;
  if (first === undefined) return false;
  if (first === "list" || first === "ls") {
    return !argv.includes("--token-status");
  }
  if (first === "status") return second === undefined || second === "--json";
  if (first === "claude") {
    return second === "list" || second === "ls" || second === "usage";
  }
  if (first === "codex") return second === "list" || second === "accounts";
  if (first === "agy") {
    return second === "list" || second === "status" || second === "usage";
  }
  if (VENDOR_TOOLS.has(first)) {
    return second === "list" || second === "accounts";
  }
  if (first === "vendors" || first === "tools") {
    const sub = argv[1];
    if (sub === undefined || sub === "status" || sub === "capabilities") return true;
    if (sub === "-h" || sub === "--help" || sub === "--json") return true;
    return false;
  }
  if (first === "usage") {
    return !argv.includes("--refresh") && !argv.includes("--check");
  }
  if (first === "config") {
    return second === undefined || second === "list" || second === "get" || second === "path";
  }
  if (first === "alias") return second === undefined;
  if (first === "map") return second === undefined && !rest.includes("--json") && argv.length === 1;
  return false;
}

export interface FallbackResult {
  status: number | null;
  signal: NodeJS.Signals | null;
}

function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/**
 * Exec the Python CLI with identical argv. Resolution order:
 * 1. `$CCSWAP_PYTHON_CLI` (a `ccswap`-compatible executable),
 * 2. `uv run --project <repo> python -m claude_swap` (works in a checkout),
 * 3. `python3 -m claude_swap` with `PYTHONPATH=<repo>/src` (needs ccswap
 *    installed in that interpreter).
 * Unresolvable interpreters (`ENOENT`) fall through to the next candidate.
 */
export function runPythonFallback(argv: string[]): FallbackResult {
  const override = process.env["CCSWAP_PYTHON_CLI"];
  const candidates: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> =
    override !== undefined && override !== ""
      ? [{ command: override, args: argv }]
      : [
          {
            command: "uv",
            args: ["run", "--project", repoRoot(), "--no-sync", "python", "-m", "claude_swap", ...argv],
          },
          {
            command: "python3",
            args: ["-m", "claude_swap", ...argv],
            env: { ...process.env, PYTHONPATH: path.join(repoRoot(), "src") },
          },
        ];
  let last: FallbackResult = { status: 1, signal: null };
  for (const candidate of candidates) {
    const res = spawnSync(candidate.command, candidate.args, {
      stdio: "inherit",
      env: candidate.env ?? process.env,
    });
    const errno = (res.error as NodeJS.ErrnoException | undefined)?.code;
    if (errno === "ENOENT") continue;
    last = { status: res.status, signal: res.signal };
    break;
  }
  return last;
}
