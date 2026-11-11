/**
 * Application: agy remove (local file bookkeeping).
 * add/switch drive the shared native login (Keychain + `agy` CLI custody,
 * external-change verification) and stay in Python.
 */

import { ReverseLog } from "../../platform/domain/atomicFile.js";
import { backupRoot } from "../../platform/domain/paths.js";
import { failed, ok, unhandled, type UseCaseResult } from "../../accounts/application/manageAccounts.js";
import { dropAgySidecars, updateAgy } from "../adapters/agyStore.js";

export function agyRemove(root: string = backupRoot(), identifier: string, assumeYes = false): UseCaseResult {
  try {
    if (!assumeYes) return unhandled("agy remove without --yes needs a confirmation prompt");
    const reverse = new ReverseLog();
    const detail = updateAgy(root, reverse, (doc) => {
      const id = identifier.trim();
      let slot: string | null = null;
      if (/^\d+$/.test(id)) {
        const s = String(Number(id));
        if (doc.accounts[s] !== undefined) slot = s;
      } else {
        const lowered = id.toLowerCase();
        for (const [n, rec] of Object.entries(doc.accounts)) {
          if (rec.alias !== undefined && rec.alias.toLowerCase() === lowered) {
            slot = n;
            break;
          }
        }
        if (slot === null) {
          const hits = Object.entries(doc.accounts)
            .filter(([, rec]) => rec.email === id)
            .map(([n]) => n);
          if (hits.length === 1) slot = hits[0] as string;
        }
      }
      if (slot === null || doc.accounts[slot] === undefined) {
        throw new Error(`No account found with identifier: ${identifier}`);
      }
      const email = doc.accounts[slot]?.email ?? "?";
      const { [slot]: _droppedAgy, ...kept } = doc.accounts;
      void _droppedAgy;
      const next = { ...doc, accounts: kept };
      dropAgySidecars(root, reverse, slot);
      return { doc: next, result: `Removed Antigravity account ${slot} (${email})` };
    });
    return ok(detail, undefined, reverse);
  } catch (err) {
    return failed(err);
  }
}
