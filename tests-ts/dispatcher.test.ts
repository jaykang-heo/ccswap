/** Routing-table tests: ported commands run in TS, everything else falls through. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  claudeRewritten,
  isPorted,
  runPythonFallback,
} from "../src-ts/platform/application/dispatcher.js";

describe("isPorted", () => {
  const ported: string[][] = [
    // Wave 1 reads (unchanged).
    ["list"],
    ["list", "--json"],
    ["list", "--json", "--provider", "codex"],
    ["ls"],
    ["status"],
    ["status", "--json"],
    ["claude", "list"],
    ["claude", "ls"],
    ["claude", "usage"],
    ["claude", "switch", "2"],
    ["claude", "alias", "1", "dev"],
    ["codex", "list"],
    ["codex", "list", "--json"],
    ["codex", "accounts"],
    ["codex", "status"],
    ["agy", "list"],
    ["agy", "status"],
    ["agy", "usage", "--json"],
    ["muse", "list"],
    ["muse", "accounts", "--json"],
    ["muse", "status"],
    ["kiro", "list", "--json"],
    ["vendors"],
    ["vendors", "--json"],
    ["tools", "--json"],
    ["vendors", "capabilities"],
    ["vendors", "capabilities", "kiro", "--json"],
    ["usage"],
    ["usage", "--json"],
    ["usage", "muse", "kiro", "--json"],
    ["config"],
    ["config", "list", "--json"],
    ["config", "get", "ui.theme"],
    ["config", "path"],
    ["alias"],
    ["map"],
    // Wave 2: file-backed mutations attempt TS first, falling back
    // internally when they hit keychain/interactive/vendor-native flows.
    ["switch", "2"],
    ["switch"],
    ["switch", "--strategy", "best"],
    ["--switch", "--strategy", "next-available"],
    ["--switch-to", "2"],
    ["--add-account"],
    ["add"],
    ["add", "--slot", "3"],
    ["add-token", "tok"],
    ["--remove-account", "1", "--yes"],
    ["remove", "1", "--yes"],
    ["rm", "1", "--yes"],
    ["disable", "1"],
    ["enable", "1"],
    ["swap", "1", "2"],
    ["move", "1", "3"],
    ["alias", "1", "dev"],
    ["alias", "1", "--unset"],
    ["map", "1", "/tmp/x"],
    ["unmap"],
    ["unmap", "/tmp/x"],
    ["unclaimed"],
    ["unclaimed", "--purge", "abc"],
    ["export", "/tmp/out.json"],
    ["--export", "-"],
    ["import", "/tmp/out.json"],
    ["--import", "-", "--force"],
    ["import-usage", "/tmp/u.json"],
    ["config", "set", "ui.theme", "dark"],
    ["config", "unset", "ui.theme"],
    ["codex", "add"],
    ["codex", "remove", "1", "--yes"],
    ["codex", "switch", "2"],
    ["agy", "remove", "1", "--yes"],
    ["muse", "add", "work"],
    ["muse", "remove", "work"],
    ["muse", "switch", "work", "--yes"],
    ["muse", "run", "work"],
    ["muse", "usage"],
    ["muse", "usage", "--refresh"],
    ["kiro", "add", "k"],
    ["kiro", "remove", "k"],
    ["kiro", "switch", "k"],
    ["usage", "--refresh"],
    ["usage", "--check"],
    ["grok", "list"],
    ["grok", "list", "--json"],
  ];
  for (const argv of ported) {
    it(`ports: ccswap ${argv.join(" ")}`, () => {
      expect(isPorted(argv)).toBe(true);
    });
  }

  const fallthrough: string[][] = [
    ["list", "--token-status"],
    ["status", "extra", "args"],
    ["statusline"],
    ["claude"],
    ["claude", "bogus-verb"],
    ["claude", "codex"],
    ["codex", "run", "1"],
    ["codex", "auto", "--once"],
    ["codex", "redeem-reset", "1"],
    ["agy", "switch", "1"],
    ["agy", "add"],
    ["muse", "auto", "--once"],
    ["kiro", "run", "k"],
    ["vendors", "bogus"],
    ["switch", "2", "--token-status"],
    ["run", "1"],
    ["auto", "--once"],
    ["relogin", "1"],
    ["tui"],
    ["upgrade"],
    ["purge"],
    ["menubar"],
    ["help"],
    ["switch", "--help"],
    ["list", "--help"],
  ];
  for (const argv of fallthrough) {
    it(`falls through: ccswap ${argv.join(" ")}`, () => {
      expect(isPorted(argv)).toBe(false);
    });
  }
});

describe("claudeRewritten", () => {
  it("maps list/ls/usage to the Claude-roster list", () => {
    expect(claudeRewritten(["claude", "list", "--json"])).toEqual([
      "list",
      "--provider",
      "claude",
      "--json",
    ]);
    expect(claudeRewritten(["claude", "ls"])).toEqual(["list", "--provider", "claude"]);
    expect(claudeRewritten(["claude", "usage", "--json"])).toEqual([
      "list",
      "--provider",
      "claude",
      "--json",
    ]);
  });

  it("passes established verbs through unchanged", () => {
    expect(claudeRewritten(["claude", "switch", "2"])).toEqual(["switch", "2"]);
    expect(claudeRewritten(["claude", "--switch-to", "2"])).toEqual(["--switch-to", "2"]);
    expect(claudeRewritten(["claude", "alias", "1", "dev"])).toEqual(["alias", "1", "dev"]);
  });

  it("returns null for unknown verbs and bare claude", () => {
    expect(claudeRewritten(["claude", "bogus-verb"])).toBeNull();
    expect(claudeRewritten(["claude", "codex"])).toBeNull();
    expect(claudeRewritten(["claude"])).toBeNull();
  });
});

describe("runPythonFallback", () => {
  it("preserves argv and exit code", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccswap-stub-"));
    const stub = path.join(dir, "ccswap-stub");
    fs.writeFileSync(
      stub,
      "#!/bin/sh\necho \"stub got: $@\"\nexit 7\n",
      { mode: 0o755 },
    );
    process.env["CCSWAP_PYTHON_CLI"] = stub;
    try {
      const res = runPythonFallback(["switch", "2", "--strategy", "best"]);
      expect(res.status).toBe(7);
    } finally {
      delete process.env["CCSWAP_PYTHON_CLI"];
    }
  });
});
