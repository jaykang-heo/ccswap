/**
 * Locked vendor-roster store: `vendors/vendors.json` + `vendors/secrets/`.
 * Zod at the file boundary; every write records prior bytes (doc and secret
 * files) in the `ReverseLog`. Secret files are created 0600 and are never
 * named by alias (`<tool>-<32hex>.secret`, Python parity).
 */

import fs from 'node:fs';
import path from 'node:path';
import { ReverseLog, withFileLock } from '../../platform/domain/atomicFile.js';
import { readJsonFile } from '../../platform/domain/jsonFile.js';
import { backupRoot } from '../../platform/domain/paths.js';
import { type VendorsDoc, vendorsDocSchema } from '../domain/vendorsDoc.js';

export function vendorsFile(root: string = backupRoot()): string {
  return path.join(root, 'vendors', 'vendors.json');
}

export function secretsDir(root: string = backupRoot()): string {
  return path.join(root, 'vendors', 'secrets');
}

export function secretPath(root: string, ref: string): string {
  return path.join(secretsDir(root), `${ref}.secret`);
}

export function loadVendorsDocOrThrow(root: string): VendorsDoc {
  const raw = readJsonFile(vendorsFile(root));
  if (raw === null) throw new Error('Vendor account data is unreadable');
  const doc = vendorsDocSchema.parse(raw);
  if (doc.schemaVersion > 1) throw new Error('Vendor account data is unreadable');
  return doc;
}

export function updateVendorsDoc<T>(
  root: string,
  reverse: ReverseLog,
  mutate: (doc: VendorsDoc) => { doc: VendorsDoc; result: T },
): T {
  return withFileLock(root, () => {
    let doc: VendorsDoc;
    try {
      doc = loadVendorsDocOrThrow(root);
    } catch {
      doc = { schemaVersion: 1, tools: {} };
    }
    const out = mutate(structuredClone(doc));
    const file = vendorsFile(root);
    reverse.record(file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(out.doc, null, 2)}\n`);
    return out.result;
  });
}

/** Write a secret ref file (0600) with reverse. */
export function writeSecretFile(root: string, reverse: ReverseLog, ref: string, secret: string): void {
  const dir = secretsDir(root);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Best effort.
  }
  const file = secretPath(root, ref);
  reverse.record(file);
  fs.writeFileSync(file, secret.endsWith('\n') ? secret : `${secret}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Best effort.
  }
}

/** Drop a secret ref file with reverse (restores bytes on rollback). */
export function dropSecretFile(root: string, reverse: ReverseLog, ref: string | null): boolean {
  if (!ref) return false;
  const file = secretPath(root, ref);
  try {
    if (!fs.statSync(file).isFile()) return false;
  } catch {
    return false;
  }
  reverse.record(file);
  fs.unlinkSync(file);
  return true;
}

/** Read a secret (memory only — never logged, never embedded in payloads). */
export function readSecretFile(root: string, ref: string | null): string | null {
  if (!ref) return null;
  try {
    const file = secretPath(root, ref);
    if (fs.lstatSync(file).isSymbolicLink()) return null;
    return fs.readFileSync(file, 'utf-8').trim();
  } catch {
    return null;
  }
}
