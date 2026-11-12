/** Vendor store adapter: metadata reads only (secrets are never read). */

import { execFileSync } from "node:child_process";
import path from "node:path";
import { readJsonFile } from "../../platform/domain/jsonFile.js";
import { backupRoot } from "../../platform/domain/paths.js";
import {
  parseVendorAccounts,
  type VendorAccount,
  type VendorsDoc,
  vendorsDocSchema,
} from "../domain/vendorsDoc.js";

export interface VendorsLoad {
  doc: VendorsDoc | null;
  unreadable: boolean;
}

export function loadVendorsDoc(root: string = backupRoot()): VendorsLoad {
  const raw = readJsonFile(path.join(root, "vendors", "vendors.json"));
  if (raw === null) return { doc: null, unreadable: true };
  try {
    const doc = vendorsDocSchema.parse(raw);
    if (doc.schemaVersion > 1) return { doc: null, unreadable: true };
    return { doc, unreadable: false };
  } catch {
    return { doc: null, unreadable: true };
  }
}

export function toolAccounts(doc: VendorsDoc | null, tool: string): VendorAccount[] {
  const entry = doc?.tools[tool];
  if (!entry) return [];
  return parseVendorAccounts(entry.accounts);
}

export function toolActive(doc: VendorsDoc | null, tool: string): string | null {
  return doc?.tools[tool]?.active ?? null;
}

export interface BinaryProbe {
  installed: boolean;
  version: string | null;
}

const VERSION_ARGV: Record<string, string[]> = {
  muse: ["muse", "--version"],
  kiro: ["kiro-cli", "--version"],
};

/** Binary each vendor tool probes (Python parity: `ToolAdapter.binary`). */
export function probeBinaryFor(tool: string): string {
  return VERSION_ARGV[tool]?.[0] ?? tool;
}

/** Local read: is the vendor CLI on PATH and what does it report? */
export function probeBinary(tool: string, timeoutMs = 5000): BinaryProbe {
  const [binary, ...rest] = VERSION_ARGV[tool] ?? [tool, "--version"];
  const argv = rest.length > 0 ? rest : ["--version"];
  try {
    const out = execFileSync(binary as string, argv, {
      timeout: timeoutMs,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return { installed: true, version: parseVersion(out) };
  } catch {
    return { installed: false, version: null };
  }
}

/** Python parity: `core.parse_version` (first `\d+.\d+.\d+...` match). */
export function parseVersion(text: string): string | null {
  const match = /\d+\.\d+\.\d+(?:[-+.][0-9A-Za-z.\-+]+)?/.exec(text);
  return match?.[0] ?? null;
}
