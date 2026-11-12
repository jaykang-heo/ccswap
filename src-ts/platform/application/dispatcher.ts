/**
 * Dispatcher: run ported commands in TS, pass everything else to the
 * existing Python CLI unchanged (args and exit code preserved).
 * Porting cut: docs/migration/behavior-matrix.md §§ "Wave-1" + wave-2
 * (file-backed mutations, local probes, overview/statusline backends).
 *
 * TS attempts a command when its inputs are local files; when the attempt
 * hits an unported sub-condition (keychain-only backups, live session
 * profiles, interactive prompts, browser/vendor-native flows) the use-case
 * returns `handled: false` and `main()` falls through to Python with the
 * original argv. Output parity is therefore exact on every path.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VENDOR_TOOLS = new Set(["muse", "kiro"]);

function isHelp(argv: string[]): boolean {
  return argv.includes("-h") || argv.includes("--help");
}

export function isPorted(argv: string[]): boolean {
  const [first, second] = argv;
  if (first === undefined) return false;
  if (isHelp(argv)) return false;
  // Wave 1: read-only commands (except --token-status, which reads the keychain).
  if (first === "list" || first === "ls") {
    return !argv.includes("--token-status");
  }
  if (first === "status") return second === undefined || second === "--json";
  // `statusline` stays in Python: its contract is the themed ANSI render of
  // the stdin snapshot (`statusline.py render()`); the TS data backend lives
  // in `overview/application/collect.ts` for future frontends.
  if (first === "statusline") return false;
  if (first === "claude") {
    // `claude <verb>` rewrites to the top-level spelling first (Python
    // `claude_argv` parity); port whatever the rewritten argv ports.
    // Unknown verbs return null → Python prints the exit-2 hint.
    const rewritten = claudeRewritten(argv);
    if (rewritten === null) return false;
    return isPorted(rewritten);
  }
  if (first === "codex") {
    if (second === "list" || second === "accounts" || second === "status") return true;
    // add/remove/switch attempt the file-backed core, falling back internally.
    if (second === "add" || second === "remove" || second === "switch") return true;
    return false;
  }
  if (first === "agy") {
    if (second === "list" || second === "status" || second === "usage") return true;
    if (second === "remove") return true;
    return false;
  }
  if (first === "grok") return true; // known tool: explicit unsupported answers
  if (VENDOR_TOOLS.has(first)) {
    if (second === "list" || second === "accounts" || second === "status") return true;
    if (second === "add" || second === "remove") return true;
    if (second === "switch" || second === "usage") return true;
    if (second === "run") return first === "muse";
    return false;
  }
  if (first === "vendors" || first === "tools") {
    const sub = argv[1];
    if (sub === undefined || sub === "status" || sub === "capabilities") return true;
    // Wave-1 flag spellings (anything else is argparse's exit-2 domain).
    if (sub === "-h" || sub === "--help" || sub === "--json") return true;
    return false;
  }
  if (first === "usage") {
    if (argv.includes("--token-status")) return false;
    return true; // cached, --refresh, and --check all attempt TS first
  }
  if (first === "config") {
    if (second === undefined || second === "list" || second === "get" || second === "path") return true;
    // set/unset attempt TS; action keys fall back internally.
    if (second === "set" || second === "unset") return true;
    return false;
  }
  if (first === "alias") return true;
  if (first === "map" || first === "unmap") return true;
  if (first === "unclaimed") return true;
  if (first === "export" || first === "--export") return true;
  if (first === "import" || first === "--import") return true;
  if (first === "import-usage" || first === "--import-usage") return true;
  // Top-level mutating verbs (flag spellings included).
  if (
    first === "switch" || first === "--switch" || first === "--switch-to" ||
    first === "--add-account" || first === "add" || first === "add-token" ||
    first === "--remove-account" || first === "remove" || first === "rm" ||
    first === "disable" || first === "enable" ||
    first === "swap" || first === "move"
  ) {
    if (argv.includes("--token-status")) return false;
    return true;
  }
  return false;
}

/** `claude list|ls|usage` shows the Claude roster (`--list --provider claude`). */
const CLAUDE_LIST_VERBS = new Set(["list", "ls", "usage"]);

/**
 * Every other established top-level Claude verb passes through unchanged
 * (other tools' namespaces are deliberately NOT reachable via `claude`).
 * Mirrors `_CLAUDE_VERBS` + `_claude_passthrough()` in `vendors/cli.py`.
 */
const CLAUDE_PASSTHROUGH = new Set([
  "status", "add", "add-token", "remove", "rm", "disable", "enable",
  "relogin", "export", "import", "import-usage", "purge", "upgrade",
  "update", "tui", "watch", "menubar", "switch", "run", "auto",
  "config", "map", "unmap", "unclaimed", "alias", "swap", "move",
]);

/**
 * `ccswap claude <verb> ...` → the top-level spelling (Python `claude_argv`
 * parity). Null when the verb is unknown → the caller falls through to
 * Python, which prints the exit-2 hint.
 */
export function claudeRewritten(argv: string[]): string[] | null {
  const [, verb, ...rest] = argv;
  if (verb === undefined) return null;
  if (CLAUDE_LIST_VERBS.has(verb)) return ["list", "--provider", "claude", ...rest];
  if (verb.startsWith("-") || CLAUDE_PASSTHROUGH.has(verb)) return [verb, ...rest];
  return null;
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
