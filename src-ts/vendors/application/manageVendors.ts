/**
 * Application: vendor roster commands (muse/opencode/kiro/grok).
 * Local bookkeeping (add/remove/active-mark) runs in TS with zod at the
 * boundary and a reverse path. Steps that exec or drive the vendor product
 * (interactive logins, `auth switch` where native, `run` exec, `auto`
 * polling) use an injectable `VendorExec`; the default runs the real binary,
 * parity tests stub it, and interactive flows report `handled: false` so the
 * dispatcher falls through to Python.
 */

import { execFile } from "node:child_process";
import { ReverseLog } from "../../platform/domain/atomicFile.js";
import { CcswapError, ConfigError, ValidationError } from "../../platform/domain/errors.js";
import { backupRoot } from "../../platform/domain/paths.js";
import { parseVendorAccounts } from "../domain/vendorsDoc.js";
import {
  findVendorIndex,
  vendorAddMutation,
  vendorRemoveMutation,
  vendorSetActiveMutation,
} from "../domain/vendorMutations.js";
import {
  dropSecretFile,
  loadVendorsDocOrThrow,
  readSecretFile,
  updateVendorsDoc,
  writeSecretFile,
} from "../adapters/vendorRosterStore.js";
import { failed, ok, unhandled, type UseCaseResult } from "../../accounts/application/manageAccounts.js";

export interface VendorExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export type VendorExec = (
  binary: string,
  args: string[],
  input?: string,
  timeoutMs?: number,
) => Promise<VendorExecResult>;

export const realVendorExec: VendorExec = (binary, args, input, timeoutMs) =>
  new Promise((resolve) => {
    const child = execFile(
      binary,
      args,
      { timeout: timeoutMs ?? 20_000, encoding: "utf-8", maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          resolve({ ok: false, stdout, stderr: `${err.message}\n${stderr}` });
        } else {
          resolve({ ok: true, stdout, stderr });
        }
      },
    );
    if (input !== undefined && child.stdin) {
      child.stdin.write(input);
      child.stdin.end();
    }
  });

export const KNOWN_VENDOR_TOOLS = ["muse", "opencode", "kiro", "grok"] as const;

function requireKnownTool(tool: string): void {
  if (!(KNOWN_VENDOR_TOOLS as readonly string[]).includes(tool)) {
    throw new ConfigError(
      `Unknown vendor '${tool}'. Known: ${(KNOWN_VENDOR_TOOLS as readonly string[]).join(", ")}`,
    );
  }
}

function grokGuard(tool: string): UseCaseResult | null {
  if (tool !== "grok") return null;
  // Registered as a known tool (never invented as unknown), but the product
  // has no supported mechanism yet — every mutating verb is exit 3.
  return {
    code: 3,
    message: "the product cannot do it (grok has no supported account mechanism yet)",
    reverse: new ReverseLog(),
    handled: true,
  };
}

export interface VendorAddOptions {
  kind?: string | undefined;
  provider?: string | undefined;
  secretStdin?: string | null | undefined;
  fromFile?: string | null | undefined;
  browser?: boolean | undefined;
  social?: string | undefined;
  license?: string | undefined;
  yes?: boolean | undefined;
}

export function vendorAdd(
  root: string = backupRoot(),
  tool: string,
  alias: string,
  opts: VendorAddOptions = {},
  readSecretInput?: () => string | null,
): UseCaseResult {
  try {
    const grok = grokGuard(tool);
    if (grok) return grok;
    requireKnownTool(tool);
    if (tool === "opencode" && !opts.provider) {
      return { code: 2, message: "opencode add needs --provider", reverse: new ReverseLog(), handled: true };
    }
    if (tool === "muse" && opts.browser && !opts.fromFile) {
      return unhandled("muse add --browser reads the live browser login via the vendor product");
    }
    const secret = opts.secretStdin ?? readSecretInput?.() ?? null;
    const kind = opts.kind ?? defaultKind(tool, opts);
    const reverse = new ReverseLog();
    const detail = updateVendorsDoc(root, reverse, (doc) => {
      const m = vendorAddMutation(doc, tool, {
        alias,
        kind,
        provider: opts.provider ?? null,
        identity: {},
        loginHint: opts.fromFile ?? "",
      }, kind === "api-key" ? secret : null);
      if (m.secretWrite) writeSecretFile(root, reverse, m.secretWrite.alias, m.secretWrite.secret);
      return { doc: m.doc, result: m.detail };
    });
    return ok(detail, undefined, reverse);
  } catch (err) {
    return failed(err);
  }
}

function defaultKind(tool: string, opts: VendorAddOptions): string {
  if (tool === "muse") {
    if (opts.fromFile) return "browser";
    return opts.secretStdin !== undefined && opts.secretStdin !== null ? "api-key" : "api-key";
  }
  if (tool === "opencode") return "login";
  return opts.social ?? opts.license ? "login" : "api-key";
}

export function vendorRemove(
  root: string = backupRoot(),
  tool: string,
  identifier: string,
  provider?: string,
): UseCaseResult {
  try {
    const grok = grokGuard(tool);
    if (grok) return grok;
    requireKnownTool(tool);
    const reverse = new ReverseLog();
    const detail = updateVendorsDoc(root, reverse, (doc) => {
      const entry = doc.tools[tool] as { accounts?: unknown[] } | undefined;
      const parsed = parseVendorAccounts(Array.isArray(entry?.accounts) ? (entry.accounts) : []);
      const m = vendorRemoveMutation(doc, tool, identifier, provider, parsed);
      if (m.secretDrop) dropSecretFile(root, reverse, m.secretDrop);
      return { doc: m.doc, result: m.detail };
    });
    return ok(detail, undefined, reverse);
  } catch (err) {
    return failed(err);
  }
}

export interface VendorSwitchOptions {
  yes?: boolean | undefined;
  login?: boolean | undefined;
  provider?: string | undefined;
  exec?: VendorExec | undefined;
}

/**
 * muse api-key switch runs `muse auth set` (needs --yes); browser switches,
 * kiro interactive flows, and opencode native `auth switch` stay in Python.
 */
export async function vendorSwitch(
  root: string,
  tool: string,
  identifier: string,
  opts: VendorSwitchOptions = {},
): Promise<UseCaseResult> {
  try {
    const grok = grokGuard(tool);
    if (grok) return grok;
    requireKnownTool(tool);
    const exec = opts.exec ?? realVendorExec;
    const doc = loadVendorsDocOrThrow(root);
    const entry = doc.tools[tool] as { accounts?: unknown[]; active?: string | null } | undefined;
    const parsed = parseVendorAccounts(Array.isArray(entry?.accounts) ? (entry.accounts) : []);
    const idx = findVendorIndex(parsed, identifier, opts.provider);
    const record = parsed[idx];
    if (!record) throw new ConfigError(`Unknown account '${identifier}'`);
    if (tool === "kiro" || tool === "opencode") {
      return unhandled(`${tool} switch drives the vendor's interactive/native login flow`);
    }
    if (record.kind === "browser") {
      return unhandled("muse browser switch restores a stored login via the vendor product");
    }
    const secret = readSecretFile(root, record.secretRef);
    if (!secret) throw new ConfigError(`Account '${record.alias}' has no stored API key`);
    if (!opts.yes) {
      throw new ConfigError(
        `Switching replaces the credential stored by Muse. Re-run with --yes to confirm, or use \`ccswap muse run ${record.alias}\` to launch without changing anything`,
      );
    }
    const res = await exec("muse", ["auth", "set", "--provider", "meta", "--api-key-stdin"], `${secret}\n`);
    if (!res.ok) throw new ConfigError(`\`muse auth set\` failed: ${res.stderr.slice(0, 300)}`);
    const reverse = new ReverseLog();
    const detail = updateVendorsDoc(root, reverse, (d) => {
      const m = vendorSetActiveMutation(d, tool, record.alias);
      return { doc: m.doc, result: m.detail };
    });
    return ok(`${detail}. Running Muse sessions keep their old credential until restarted`, undefined, reverse);
  } catch (err) {
    return failed(err);
  }
}

/** `muse run ALIAS [-- ...]`: API-key accounts only; exec stays in Python. */
export function vendorRun(
  root: string,
  tool: string,
  identifier: string,
  provider?: string,
): UseCaseResult {
  try {
    const grok = grokGuard(tool);
    if (grok) return grok;
    requireKnownTool(tool);
    const doc = loadVendorsDocOrThrow(root);
    const entry = doc.tools[tool] as { accounts?: unknown[] } | undefined;
    const parsed = parseVendorAccounts(Array.isArray(entry?.accounts) ? (entry.accounts) : []);
    const idx = findVendorIndex(parsed, identifier, provider);
    const record = parsed[idx];
    if (!record) throw new ConfigError(`Unknown account '${identifier}'`);
    if (tool === "opencode") {
      return { code: 3, message: "not possible (opencode run)", reverse: new ReverseLog(), handled: true };
    }
    if (record.kind !== "api-key") {
      return unhandled(`${tool} run for non-API-key accounts execs the vendor product`);
    }
    const secret = readSecretFile(root, record.secretRef);
    if (!secret) throw new ConfigError(`Account '${record.alias}' has no stored API key`);
    // The child takes over the terminal; exec semantics stay in Python.
    return unhandled(`${tool} run execs the vendor binary with the stored key`);
  } catch (err) {
    if (err instanceof CcswapError) return failed(err);
    return failed(err);
  }
}

export function vendorStatus(
  root: string = backupRoot(),
  tool: string,
): UseCaseResult {
  try {
    requireKnownTool(tool);
    const doc = loadVendorsDocOrThrow(root);
    const entry = doc.tools[tool] as { accounts?: unknown[]; active?: string | null } | undefined;
    const parsed = parseVendorAccounts(Array.isArray(entry?.accounts) ? (entry.accounts) : []);
    return ok(`${tool}: ${String(parsed.length)} account(s)`, {
      schemaVersion: 1,
      tool,
      active: entry?.active ?? null,
      accounts: parsed.length,
    }, new ReverseLog());
  } catch (err) {
    return failed(err);
  }
}

void ValidationError;
