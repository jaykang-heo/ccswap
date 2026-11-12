# Python to TypeScript command migration status

This inventory reflects the current `src-ts/platform/application/dispatcher.ts`
and `src-ts/main.ts` routing. “TS” means the command is dispatched to the
TypeScript implementation; individual unsupported situations can still fall
back to Python as noted. “Python” means the command is dispatched unchanged to
`python -m claude_swap`.

| Python command / family | TypeScript status | Remaining Python behavior |
|---|---|---|
| `list`, `ls` | TS | `--token-status` |
| `status` | TS | Extra positional arguments / unsupported forms |
| `statusline` | Python | Entire command, including themed ANSI rendering |
| `switch` and legacy switch flags | TS | Keychain-only, interactive, or live session cases handled by fallback |
| `add`, `add-token`, `remove`, `rm`, `disable`, `enable` | TS | Interactive and keychain-only cases handled by fallback |
| `relogin` | Python | Entire browser OAuth flow |
| `alias`, `map`, `unmap`, `unclaimed` | TS | Unsupported or interactive subcases handled by fallback |
| `swap`, `move` | TS | File backups only; keychain-only state remains on fallback |
| `export`, `import`, `import-usage` | TS | Unsupported transfer cases handled by fallback |
| `config` | TS | Service action keys and unsupported forms handled by fallback |
| `usage` | TS attempt | Token-status path; live probes other than the supported Muse probe fall back to Python |
| `vendors`, `tools` | TS | Invalid/unported subcommands |
| `muse`, `kiro` list/status/add/remove/switch/usage | TS | Native interactive/login flows and unsupported subcommands; cached usage is TS, live probe support is partial |
| `muse run ALIAS` | TS for registered API-key accounts | `@key`, browser-login accounts, unknown accounts, and child spawn errors fall back to Python |
| `kiro run` | Python | Entire command, including stored Kiro login behavior |
| `codex` list/accounts/status/add/remove/switch | TS | Unsupported subcommands and unported live flows |
| `codex run`, `auto`, `redeem-reset` | Python | Entire command families |
| `agy` list/status/usage/remove | TS | `agy add` and `agy switch` |
| `grok` | TS | Explicit unsupported response; no Python implementation counterpart |
| `run` | Python | Entire Claude session launcher |
| `auto` | Python | Entire auto-switch and service lifecycle |
| `tui`, bare interactive CLI, `watch` | Python | Entire interactive frontends |
| `menubar` | Python | Entire menu bar app and service lifecycle |
| `upgrade`, `update`, `purge`, `help`, version/debug plumbing | Python | Entire command / top-level handling |
| `claude <verb>` | TS rewrite then target routing | Unknown verbs and all targets still routed to Python |

The TS build is `dist/ccswap.mjs` (`pnpm run build`). It currently still
contains a Python fallback for commands listed above; therefore Python source
and tests remain part of the installed runtime and the migration goal of zero
`.py` files has not been reached.

## Next port slice

The top-level `run` and interactive `tui` free paths remain on Python. Vendor
`run` uses TypeScript only for registered Muse API-key accounts. Muse lane key
selection, browser-login accounts, all Kiro runs, and child
spawn errors retain Python behavior. Vendor usage is dispatched through TS
for cached readings, while live measurements remain a mixed TS/Python path.
