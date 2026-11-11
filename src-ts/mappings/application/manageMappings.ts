/**
 * Application: map / unmap (mutating forms). The zero-arg list form stays in
 * `main.ts` (wave 1). Identity is `(email, orgUuid)` — never the slot number.
 */

import { ReverseLog } from "../../platform/domain/atomicFile.js";
import { backupRoot } from "../../platform/domain/paths.js";
import { loadClaudeRoster } from "../../accounts/adapters/roster.js";
import { failed, ok, type UseCaseResult } from "../../accounts/application/manageAccounts.js";
import { normalizeMappingPath } from "../domain/mappingDoc.js";
import { updateMappings } from "../adapters/mappingStore.js";

function nowStamp(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

export function mapAccount(
  root: string = backupRoot(),
  identifier: string,
  dir?: string,
): UseCaseResult {
  try {
    if (dir === undefined) {
      return {
        code: 2,
        message: "map needs an account and a path",
        reverse: new ReverseLog(),
        handled: true,
      };
    }
    const reverse = new ReverseLog();
    const { sequence } = loadClaudeRoster(root);
    const id = identifier.trim();
    let slot: string | null = null;
    if (/^\d+$/.test(id)) {
      const s = String(Number(id));
      if (sequence.accounts[s] !== undefined) slot = s;
    } else {
      const lowered = id.toLowerCase();
      for (const [n, rec] of Object.entries(sequence.accounts)) {
        if (rec.alias === lowered) {
          slot = n;
          break;
        }
      }
      if (slot === null) {
        const hits = Object.entries(sequence.accounts)
          .filter(([, rec]) => rec.email === id)
          .map(([n]) => n);
        if (hits.length === 1) slot = hits[0] as string;
      }
    }
    if (slot === null) {
      return { code: 1, message: `No account found with identifier: ${identifier}`, reverse, handled: true };
    }
    const rec = sequence.accounts[slot];
    if (!rec) {
      return { code: 1, message: `Account-${slot} does not exist`, reverse, handled: true };
    }
    const key = normalizeMappingPath(dir);
    const out = updateMappings(root, reverse, (doc) => ({
      doc: {
        ...doc,
        mappings: {
          ...doc.mappings,
          [key]: { email: rec.email, organizationUuid: rec.organizationUuid, added: nowStamp() },
        },
      },
      note: `Mapped ${key} → Account-${slot} (${rec.email})`,
      result: slot,
    }));
    return ok(out.note, undefined, reverse);
  } catch (err) {
    return failed(err);
  }
}

export function unmapPath(root: string = backupRoot(), dir?: string): UseCaseResult {
  try {
    const reverse = new ReverseLog();
    const target = dir ?? process.cwd();
    const key = normalizeMappingPath(target);
    const out = updateMappings(root, reverse, (doc) => {
      if (doc.mappings[key] === undefined) {
        return { doc, note: `No mapping for ${key}`, result: false };
      }
      const { [key]: _unmapped, ...kept } = doc.mappings;
      void _unmapped;
      return { doc: { ...doc, mappings: kept }, note: `Removed mapping for ${key}`, result: true };
    });
    return ok(out.note, undefined, reverse);
  } catch (err) {
    return failed(err);
  }
}
