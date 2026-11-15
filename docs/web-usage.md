# Web dashboard and real-time usage

ccswap has two sources for Claude usage:

- **OAuth**, the default. Anthropic's usage API allows roughly 30 requests an hour per account, so it refreshes every few minutes at best.
- **web**, optional. claude.ai's own usage endpoint returns the same numbers and tolerates a much higher rate, so ccswap refreshes it every 20 seconds. It needs one session key per account.

When a web reading is newer than the OAuth one, ccswap uses the web reading. `ccswap list --json` and the dashboard report it as `source: "web"`; the human `ccswap list` shows the numbers without naming the source. An OAuth reading has no `source` field.

## 1. Add a key for each account

A web key is the claude.ai `sessionKey` cookie. One key covers every organization of its account email.

1. In a browser logged in as the account, open claude.ai.
2. Open DevTools, then Application > Cookies > `https://claude.ai`.
3. Copy the value of `sessionKey`.
4. Run:

   ```bash
   ccswap web-key set 1          # NUM is the account number from `ccswap list`
   ccswap web-key set 1 --stdin  # or pipe the key in, for scripts
   ccswap web-key list           # or --json; never prints key values
   ccswap web-key remove 1
   ```

`set` checks the key against claude.ai before saving it. It refuses a key that belongs to a different account, and it saves nothing in that case.

The key is stored in the macOS Keychain (service `ccswap-web-session`, account = the email). On other platforms it is stored in `<backup root>/web_keys.json` with mode 0600.

## 2. Keep the dashboard running

```bash
ccswap web install [--port 4592] [--https-port 8443]
```

This does three things:

1. Installs a LaunchAgent, `io.github.ccswap.web`, that runs `ccswap web serve --port 4592` at login. launchd restarts it after a crash.
2. Runs `tailscale serve --bg --https=8443 http://127.0.0.1:4592`.
3. Prints the tailnet URL, `https://<node>.<tailnet>.ts.net:8443/`, read from `tailscale status --json`.

If Tailscale is not installed, step 2 is skipped. The LaunchAgent still installs, and the command prints the local URL.

Tailscale's `serve --https` needs HTTPS certificates enabled for your tailnet in the Tailscale admin console. If the command reports that HTTPS is not enabled, turn it on there and run `ccswap web install` again.

`install` refuses to proceed if the chosen HTTPS port already serves something other than this dashboard. Pick another with `--https-port`. Nothing is changed in that case.

Other commands:

```bash
ccswap web serve [--port 4592]   # foreground, for trying it out
ccswap web status [--json]       # agent loaded?, local page answering?, tailnet URL
ccswap web uninstall             # removes the LaunchAgent and our HTTPS mapping only
```

## 3. Open it on your phone

Open the tailnet URL from `ccswap web install` or `ccswap web status` while your phone is connected to Tailscale. The page:

- shows one card per Claude account, with the active account marked,
- draws bars for the 5-hour window, the 7-day window, and each per-model 7-day window (such as Fable), with percentages and a live "resets in" countdown,
- shows `source web · 12s ago` or `source oauth · 3m ago` for each account,
- refreshes itself every 15 seconds without reloading the page,
- shows a banner when the newest reading is more than 2 minutes old, or when the Mac cannot be reached.

The page follows the phone's light or dark setting.

## Security

- The server listens only on `127.0.0.1`. Nothing else on your network can reach it.
- `tailscale serve` exposes it to your tailnet only. Do not use `tailscale funnel` for this port, because Funnel makes it public on the internet.
- The API returns account emails, organization names, and usage. It never returns session keys.
- There is no login on the page. Tailnet membership is the access control.

## Failure behavior

Web readings degrade silently to OAuth. Nothing breaks, and no account loses its usage display.

| Situation | What ccswap does |
| --- | --- |
| No key for an account | That account uses OAuth only. |
| Key rejected (HTTP 401, or 403 with a JSON body) | Error `web-key-invalid`. The account falls back to its OAuth reading. Web is not retried for 10 minutes. Update the key with `ccswap web-key set N`. |
| Cloudflare block (403 with an HTML challenge) | Error `web-blocked`. The account falls back to OAuth. Web is not retried for 5 minutes. A block is not a bad key. |
| Rate limited (HTTP 429) | Error `http-429`. Web is retried after `Retry-After`, at least 60 seconds. |
| Network error, timeout (5 seconds), or other HTTP error | The account falls back to OAuth. The next attempt happens on the next pass. |
| curl_cffi not installed | Web usage is disabled. OAuth only. |

The reason is recorded in the account's cache, and `ccswap web-key list` shows it.

If an account's key is fixed, the stored retry window still applies until it passes. To retry immediately, run `ccswap web-key set N` and then wait for the window to expire.

## Files

- `src/claude_swap/web_usage.py`: web source, key storage, cache, and overlay.
- `src/claude_swap/web_server.py`: HTTP server, background collection, and the page.
- `src/claude_swap/web_cli.py`: the `ccswap web` command and the tailscale and LaunchAgent wiring.
- `src/claude_swap/web_assets/index.html`: the dashboard page, shipped inside the package.
