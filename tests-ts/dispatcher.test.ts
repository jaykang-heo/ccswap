/** Routing-table tests: ported commands run in TS, everything else falls through. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isPorted, runPythonFallback } from "../src-ts/platform/application/dispatcher.js";

describe("isPorted", () => {
  const ported: string[][] = [
    ["list"],
    ["list", "--json"],
    ["list", "--json", "--provider", "codex"],
    ["ls"],
    ["status"],
    ["status", "--json"],
    ["claude", "list"],
    ["claude", "ls"],
    ["claude", "usage"],
    ["codex", "list"],
    ["codex", "list", "--json"],
    ["codex", "accounts"],
    ["agy", "list"],
    ["agy", "status"],
    ["agy", "usage", "--json"],
    ["muse", "list"],
    ["muse", "accounts", "--json"],
    ["opencode", "list"],
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
  ];
  for (const argv of ported) {
    it(`ports: ccswap ${argv.join(" ")}`, () => {
      expect(isPorted(argv)).toBe(true);
    });
  }

  const fallthrough: string[][] = [
    ["list", "--token-status"],
    ["claude", "switch", "2"],
    ["codex", "switch", "2"],
    ["agy", "switch", "1"],
    ["agy", "add"],
    ["agy", "remove", "1", "--yes"],
    ["muse", "add", "work"],
    ["muse", "switch", "work"],
    ["muse", "run", "work"],
    ["muse", "usage", "--refresh"],
    ["opencode", "switch", "oc"],
    ["kiro", "switch", "k"],
    ["vendors", "bogus"],
    ["usage", "--refresh"],
    ["usage", "--check"],
    ["config", "set", "ui.theme", "dark"],
    ["config", "unset", "ui.theme"],
    ["alias", "1", "dev"],
    ["map", "1"],
    ["switch", "2"],
    ["auto", "--once"],
    ["run", "1"],
    ["add"],
    ["remove", "1"],
    ["swap", "1", "2"],
    ["tui"],
    ["upgrade"],
    ["purge"],
    ["statusline"],
  ];
  for (const argv of fallthrough) {
    it(`falls through: ccswap ${argv.join(" ")}`, () => {
      expect(isPorted(argv)).toBe(false);
    });
  }
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
