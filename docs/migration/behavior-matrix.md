# ccswap behavior matrix (Python → TypeScript strangler migration)

Source of truth for the strangler migration (P6). Generated from
`src/claude_swap/cli.py`, `src/claude_swap/vendors/cli.py`,
`src/claude_swap/switcher.py`, `src/claude_swap/codex.py`,
`src/claude_swap/agy.py`, `src/claude_swap/settings.py`,
`src/claude_swap/vendors/{store,service,overview,usage_cache}.py`,
`docs/commands.md`, and `docs/vendor-compatibility.md` on 2026-11-11.

Conventions: exit `0` ok, `1` error, `2` CLI usage error (argparse),
`3` the vendor product cannot do it, `130` interrupted. `--json` always
emits machine-readable JSON on stdout (see `docs/json.md`); human output
goes to stdout, errors to stderr. Secrets are only read from stdin or a
hidden prompt, never from argv. Unknown vendor values are shown as unknown,
never invented.

State roots (see `src/claude_swap/paths.py`):

| Root | Location |
|---|---|
| Claude roster | `<backup>/sequence.json` (`accounts`, `sequence`, `activeAccountNumber`) |
| Claude usage cache | `<backup>/cache/usage.json` (schemaVersion 2, `accounts` keyed by slot) |
| Codex roster | `<backup>/codex/sequence.json` |
| Vendor roster (metadata only) | `<backup>/vendors/vendors.json` (schemaVersion 1) |
| Vendor secrets | `<backup>/vendors/secrets/<random-id>.secret` (0600, never named by alias) |
| Vendor usage cache | `<backup>/vendors/usage.json` (`entries`, key `"<tool>\x1f<account>"`) |
| Antigravity roster | `<backup>/agy/accounts.json`, per-account `account-<n>.json` + `usage-<n>.json` |
| Settings | `<backup>/settings.json` (camelCase, schema version 1) |

`<backup>` = `$XDG_DATA_HOME/claude-swap` on Linux/WSL, else
`~/.claude-swap-backup`. `CLAUDE_CONFIG_DIR` (else `~/.claude`) holds the
live Claude credentials (`.credentials.json`) and global config.

Keychain items read/written: macOS `security` CLI generic-password entries
for per-account credential backups (service derived per account), the
active credential, and session state; one-time `keyring` → files/security
migration for pre-0.10.x users (Windows-only `keyring` import otherwise).
The macOS migration has a `security`-CLI fallback; the legacy purge sweep
no-ops when `keyring` is absent.

## 1. accounts (Claude Code roster, top-level commands)

All of these construct `ClaudeAccountSwitcher` (backup dir + live
`~/.claude` files + macOS keychain) unless noted. Mutating commands take a
file lock (`<backup>/.lock`); concurrent switch/usage-refresh uses
resolve-validate-mutate on `sequence.json`.

| Command | Inputs | Outputs (human / `--json`) | Files / keychain | External calls | Errors |
|---|---|---|---|---|---|
| `list [--json] [--provider {claude,codex,agy,all}] [--token-status]` (`ls` alias) | provider filter, json flag | every account: slot, email, org tag, alias, 5h/7d/weekly usage + resets, active mark; `--token-status` adds source-labelled OAuth diagnostics | reads roster(s) + usage caches; may trigger paced usage refresh (network) | OAuth/usage endpoints on refresh; keychain read for token status | unreadable roster → error, exit 1; corrupt cache treated as empty |
| `status [--json]` | — | current/active account only | reads roster + active credential ref | none (local reads) | no roster → error, exit 1 |
| `add [--slot N] [--alias NAME]` | slot, alias; credentials captured from the live `claude login` session | new slot assignment | reads live credentials + global config; writes backup creds/config, `sequence.json`, keychain backup | browser/`claude login` done by the user beforehand (not invoked) | slot occupied → prompt (or `--yes`); alias conflict → `ValidationError`; credential drift → abort |
| `add-token [TOKEN\|-] [--email E]` | token via arg/stdin, email | registered slot | writes same backups as `add` | none | bad token shape → error |
| `remove NUM\|EMAIL [--yes]` | identifier | slot freed | deletes backup files + keychain entry, prunes mappings/dir-maps | none | unknown account → error |
| `disable/enable NUM\|EMAIL` | identifier | rotation flag flipped | writes `sequence.json` entry flag | none | unknown account → error |
| `relogin NUM\|EMAIL` | identifier | renewed login via browser flow | rewrites credential backup + keychain | browser OAuth flow (user-driven) | expired token, user abort |
| `alias [NUM\|EMAIL [NAME\|--unset]]` | 0 args = list (read-only); else mutate | alias table / confirmation | list: reads `sequence.json`; mutate: writes it | none | alias in use → `ValidationError` |
| `swap A B` | two identifiers | slots exchanged | read-modify-write `sequence.json` + rename backup files, keychain entries moved | none | unknown slot → error |
| `move A SLOT` | identifier + slot | account assigned to slot (swap if taken) | same as swap | none | same as swap |
| `map [NUM\|EMAIL [PATH]]` | 0 args = list (read-only) | dir→account table | reads/writes mappings file | none | — |
| `unmap [PATH]` | path (default cwd) | mapping removed | writes mappings file | none | — |
| `unclaimed [--purge ID]` | none / stash id | stashed credential entries + why stashed; `--purge` deletes bytes | reads stash; purge deletes | none | unknown id → error |
| `export PATH` / `import PATH` / `import-usage PATH [--hold S]` | file path | roster/usage transferred | reads/writes roster + usage rows | none | unreadable file → error |
| `config [list\|get KEY\|set KEY VALUE\|unset KEY\|path]` | key/value | effective settings | reads/writes `settings.json` | `set` of service keys runs install/uninstall instead of writing | unknown key, bad value → error, exit 1/2 |

## 2. usage (all tools, one pass)

| Command | Inputs | Outputs | Files / keychain | External calls | Errors |
|---|---|---|---|---|---|
| `usage [TOOL ...] [--json] [--refresh] [--check]` | tool filter (`claude codex muse kiro opencode agy`), json, refresh, check | per tool: installed? version? per-account usage windows (5h/7d/weekly/credits/local tokens) + resets, or state + reason (`available/unavailable/unsupported/unauthenticated/stale/error`); unknown stays unknown | reads all rosters + both usage caches; without `--refresh` serves cached/last-good rows; `--refresh/--check` measures live | per-tool vendor CLIs/APIs on own worker with 75 s deadline each (`muse usage --json`, kiro V2 harness, opencode local stats, OAuth endpoints); one hung tool never delays others | unknown tool → exit 1/2; `--check` exits 1 if any account cannot be shown; Ctrl-C → 130 |

## 3. switch (mutating session control — NOT ported in wave 1)

| Command | Inputs | Outputs | Files / keychain | External calls | Errors |
|---|---|---|---|---|---|
| `switch [NUM\|EMAIL] [--strategy best\|next-available\|consume-first] [--json]` | target or strategy | new active account | rewrites active credential (file + keychain), `activeAccountNumber` | usage reads to rank by headroom | no accounts / strategy finds none → error |
| `auto [--once] [--interval S] [--threshold PCT] [--cooldown S] [--dry-run] [--json] [service flags]` | polling options | JSONL events / human lines; switches when active crosses threshold | same writes as `switch` + launchd plist with `--install-service` | usage polling incl. optional 5h-window warming (disabled by default; costs subscription quota) | — |
| `run [NUM\|EMAIL] [--require-session] [--shared] [-- ...]` | account + forwarded args | execs `claude` as that account in this terminal only | reads backups; no roster writes | exec `claude` (child takes over terminal) | unknown account → error |

## 4. per-vendor stores

Vendor metadata lives in `vendors.json`; API-key secrets in `secrets/`.
`codex` and `agy` are legacy stores (own `sequence.json`/`accounts.json`),
not the vendor store. `muse`/`opencode`/`kiro` adapters implement
`ToolAdapter` (`registry.py` `DEFAULT_FACTORIES` = muse, opencode, kiro;
display order `claude, codex, muse, kiro, opencode, agy`).

| Command | Inputs | Outputs | Files / keychain | External calls | Errors |
|---|---|---|---|---|---|
| `codex list [--json]` | — | saved Codex accounts (+ usage if refreshed) | reads `<backup>/codex/sequence.json`, `auth.json` backups, `~/.codex/auth.json` (live) | usage endpoint on refresh | missing auth → `stored Codex auth.json is missing` |
| `codex switch [NUM\|EMAIL] [--strategy …] [--json]` | target/strategy | file-backed Codex login replaced | writes `~/.codex/auth.json` from backup | none | Codex must use file credential store |
| `codex run …` / `codex add [--slot]` / `codex remove …` / `codex auto …` / `codex redeem-reset …` | per-subcommand | session/private-home run; slot ops; banked-reset redeem | codex dir + sessions + manifests | Codex CLI subprocess | mirrors top-level errors |
| `muse|opencode|kiro list\|accounts [--json]` | — | registered aliases + status | reads `vendors.json` (+ vendor's own auth file for discovery) | `whoami`/equivalent for active mark | corrupt `vendors.json` → `VendorError`, exit 1 |
| `muse|opencode|kiro add …` | alias + kind-specific flags (`--api-key-stdin`, `--social`, `--license`, provider) | registration (vendor login untouched, except noted logins) | writes `vendors.json` (+ `secrets/` for API keys) | `opencode auth login` for `opencode login`; kiro interactive logout/login (guarded, verified) | bad alias → `VendorError`; exit 3 when the product cannot do it (e.g. kiro/opencode auto-switch, muse per-account switch of browser sessions) |
| `muse|opencode|kiro remove ALIAS [--json]` | alias | registration forgotten, secret file dropped | writes `vendors.json`, deletes secret ref | none | unknown alias → error |
| `muse|opencode|kiro switch ALIAS [--json]` | alias | active account changed via vendor mechanism (muse: API-key accounts only; opencode: native `auth switch` where supported; kiro: interactive, verified) | vendor auth files | vendor CLI (`muse auth set`, `opencode auth switch`, kiro login flow) | exit 3 where unsupported |
| `muse|opencode|kiro run ALIAS [-- …]` | alias + args | runs tool with that identity (API-key accounts; opencode: not possible) | reads secret ref | vendor CLI subprocess | exit 3 for opencode |
| `muse|opencode|kiro usage [--json]` | — | verified usage or why unavailable | usage cache + live measure | per-vendor mechanism (muse `usage --json`, kiro V2 harness, opencode local tokens/USD) | — |
| `muse auto …` | polling options | same shape as top-level `auto` for Muse allowance | same as `auto` scoped to muse | muse usage polling | Muse needs one credential backend (`TBH_CREDENTIAL_BACKEND=file`) |
| `agy list\|status\|usage [--json]` | — | Antigravity accounts / current login / quota groups | reads `<backup>/agy/accounts.json`, `usage-<n>.json` | quota endpoints on refresh | `OSError` → "Cannot access Antigravity account storage", exit 1 |
| `agy add` / `agy remove …` / `agy switch … [--json]` | identifier | shared-login account ops (existing CLI/App/IDE sessions may need restart) | agy dir + shared login files | `agy` CLI | — |
| `vendors [--json]` (+ `tools` alias) | — | installed? version? registered accounts? per tool | reads `vendors.json` + probes installs | `muse --version`-style probes, no auth | probe failure recorded as `error`, not fatal |
| `vendors capabilities [TOOL] [--json]` | tool? | support/mechanism table per capability | none (static adapter tables) | none | unknown tool → error |
| `claude <verb> …` | top-level Claude verbs | rewritten to the top-level command line, unchanged | same as target | same as target | unknown verb → exit 2 with hint |

## 5. frontends (NOT ported — out of scope for the strangler)

| Command | Notes |
|---|---|
| `tui` / bare `ccswap` on a TTY / `watch` | Textual dashboard + live watch page; reads the same overview (`collect`/`summary_json`) as `usage` |
| `menubar [--install-service]` | macOS `rumps` app; same backend; launchd plist for login persistence |
| `statusline` | local reads only: `sequence.json` + `cache/usage.json`; runs before TLS/theme setup; machine output for Claude Code's status line |
| `upgrade` | detects uv/pipx install, upgrades; refuses to replace this fork with upstream (`0.48.0+vendors.1` guard) |
| `purge` | removes all ccswap data |
| `help` / `--version` / `--debug` / `--token-status` / `--provider` | output/flag plumbing; `--provider {claude,codex,agy,all}` scopes `list` |

## Wave-1 porting cut (read-only commands only)

Ported to TypeScript in wave 1 (no writes, no subprocess, no network, no
keychain — cached/last-good readings only; live refresh stays in Python):

- `list [--json] [--provider …]`, `ls`, `status [--json]`
- `claude list|ls|usage`
- `codex list`, `agy list|status|usage`, `muse|opencode|kiro list|accounts`
- `vendors [--json]`, `vendors capabilities [TOOL] [--json]`
- `usage [TOOLS] [--json]` (cached; `--refresh`/`--check` fall through to Python)
- `config list|get|path`, `alias` (no args), `map` (no args)

Everything else (switch/auto/run, add/remove/disable/enable/relogin,
swap/move, unmap/unclaimed-purge, export/import, `config set/unset`,
`upgrade`, `purge`, frontends) falls through to the Python CLI with args
and exit code preserved. Mutating `alias`/`map` forms (with args) also
fall through; only the zero-arg list forms are ported.

## Wave-2 porting cut (file-backed commands + local probes)

Ported to TypeScript in wave 2 (`src-ts/<context>/{domain,application,adapters}`,
zod at every file boundary, a `ReverseLog` rollback for every state write —
see `src-ts/platform/domain/atomicFile.ts`):

- `switch [NUM|EMAIL] [--strategy …] [--json]` (direct, rotation, cached-usage
  ranking), `add`, `add-token`, `remove --yes`, `disable`/`enable`,
  `alias` set/`--unset`, `swap`, `move`, `map`/`unmap`, `unclaimed`/`--purge`,
  `export`/`import`/`import-usage`, `config set`/`unset`
- `codex add|remove|switch|status`, `agy remove`, `muse|opencode|kiro
  add|remove|status|usage` (cached), `muse` api-key `switch --yes`
- `usage [--refresh] [--check]` for muse/opencode probes; every other tool's
  live probe stays in Python
- `overview --json` and the `collectOverview`/`collectStatusline` backends
  the menubar/raycast/tui frontends render from
- `grok` as a known-but-unsupported tool (no Python counterpart): explicit
  queries answer exit 0/3 with "no supported account mechanism yet", never
  "unknown"; default tables (`vendors capabilities`, `usage`) exclude it so
  Python output parity holds

TS attempts a ported command when its inputs are local files; the use-case
returns `handled: false` and the dispatcher falls through to Python with the
original argv when it hits what TS does not do: macOS Keychain-only backups,
live session-mode profiles, interactive prompts (no `--yes`), the browser
OAuth flow (`relogin`), vendor-native/interactive flows (`opencode
login/logout`, kiro/opencode `switch`, `run` exec, `auto` polling). Output
parity is therefore exact on every path, including `claude <verb>` rewrites
(`claude list|ls|usage` → `--list --provider claude`, all other established
verbs pass through, unknown verbs exit 2 via Python).

Deliberate divergences from current Python (no Python counterpart to be
par with): explicit `grok` queries (above); `overview --json` (new surface
for frontends); `statusline` rendering stays in Python (themed ANSI contract)
while its data backend is ported. Swap/move migrate file backups only —
Keychain entries and `.prev` generations are not moved (`.enc`-wins reads
keep file state authoritative).
