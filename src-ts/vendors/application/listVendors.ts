/**
 * Application: `vendors` payload and `vendors capabilities` table.
 * Capability data mirrors `VendorService.capability_table` / adapter tables.
 */

import { probeBinary, toolAccounts, toolActive, type VendorsLoad } from "../adapters/vendorStore.js";
import { loadVendorsDoc } from "../adapters/vendorStore.js";
import { VENDOR_TOOLS } from "../../platform/domain/paths.js";

export interface VendorStatus {
  tool: string;
  label: string;
  installed: boolean;
  version: string | null;
  accounts: number;
  active: string | null;
  error: string | null;
}

const LABELS: Record<string, string> = {
  muse: "Muse Code",
  opencode: "OpenCode",
  kiro: "Kiro CLI",
};

const CAPABILITIES: Record<string, Record<string, { support: string; mechanism: string }>> = {
  muse: {
    list: { support: "yes", mechanism: "registered aliases (Muse has no whoami)" },
    switch: { support: "partial", mechanism: "API-key accounts via `muse auth set`; browser sessions: login only" },
    usage: { support: "yes", mechanism: "plan, 5-hour and weekly used % with resets (`muse usage --json`)" },
    "per-account usage": { support: "yes", mechanism: "every account, measured in isolation" },
    run: { support: "partial", mechanism: "API-key accounts only" },
    "auto-switch": { support: "no", mechanism: "the product cannot do it" },
  },
  opencode: {
    list: { support: "yes", mechanism: "provider-aware, from the vendor" },
    switch: { support: "partial", mechanism: "native `auth switch` where the installed version has it" },
    usage: { support: "partial", mechanism: "local tokens and USD estimate per provider/model; provider quotas not reported" },
    "per-account usage": { support: "partial", mechanism: "a provider's sole account" },
    run: { support: "no", mechanism: "not possible" },
    "auto-switch": { support: "no", mechanism: "the product cannot do it" },
  },
  kiro: {
    list: { support: "yes", mechanism: "active login via `whoami`" },
    switch: { support: "partial", mechanism: "interactive logout/login, guarded and verified; API keys are run, not switched" },
    usage: { support: "yes", mechanism: "plan credits used/limit and reset date (`/usage` via the V2 harness)" },
    "per-account usage": { support: "yes", mechanism: "every profile of the signed-in login, measured in isolation" },
    run: { support: "partial", mechanism: "API-key accounts only" },
    "auto-switch": { support: "no", mechanism: "the product cannot do it" },
  },
};

export function vendorsPayload(root?: string): { schemaVersion: 1; vendors: VendorStatus[] } {
  const { doc, unreadable }: VendorsLoad = loadVendorsDoc(root);
  return {
    schemaVersion: 1,
    vendors: VENDOR_TOOLS.map((tool) => {
      const probe = probeBinary(tool);
      return {
        tool,
        label: LABELS[tool] ?? tool,
        installed: probe.installed,
        version: probe.version,
        accounts: toolAccounts(doc, tool).length,
        active: toolActive(doc, tool),
        error: unreadable ? "Vendor account data is unreadable" : null,
      };
    }),
  };
}

export function capabilitiesPayload(tools: string[]): {
  schemaVersion: 1;
  vendors: Record<string, Record<string, { support: string; mechanism: string }>>;
} {
  const vendors: Record<string, Record<string, { support: string; mechanism: string }>> = {};
  for (const tool of tools) {
    const table = CAPABILITIES[tool];
    if (table) vendors[tool] = table;
  }
  return { schemaVersion: 1, vendors };
}

export function knownCapabilityTools(): string[] {
  return Object.keys(CAPABILITIES);
}

export function renderVendorsHuman(vendors: VendorStatus[]): string[] {
  return vendors.map((v) => {
    const state = v.installed ? (v.version ?? "?") : "not installed";
    const err = v.error !== null ? `  ! ${v.error}` : "";
    return `${v.label}  ${state}  accounts: ${String(v.accounts)}${err}`;
  });
}
