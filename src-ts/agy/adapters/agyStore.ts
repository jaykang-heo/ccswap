/** Locked Agy store: `agy/accounts.json` + per-account sidecars. */

import fs from 'node:fs';
import path from 'node:path';
import { ReverseLog, withFileLock } from '../../platform/domain/atomicFile.js';
import { readJsonFile } from '../../platform/domain/jsonFile.js';
import { backupRoot } from '../../platform/domain/paths.js';
import { ConfigError } from '../../platform/domain/errors.js';
import { type AgyRoster, agyRosterSchema } from '../domain/agyRoster.js';

export function agyDir(root: string = backupRoot()): string {
  return path.join(root, 'agy');
}

export function agyAccountsFile(root: string = backupRoot()): string {
  return path.join(agyDir(root), 'accounts.json');
}

export function readAgyRoster(root: string): AgyRoster {
  const raw = readJsonFile(agyAccountsFile(root));
  if (raw === null) throw new ConfigError('Cannot access Antigravity account storage');
  try {
    return agyRosterSchema.parse(raw);
  } catch {
    throw new ConfigError('Cannot access Antigravity account storage');
  }
}

export function updateAgy<T>(
  root: string,
  reverse: ReverseLog,
  mutate: (doc: AgyRoster) => { doc: AgyRoster; result: T },
): T {
  return withFileLock(root, () => {
    const doc = structuredClone(readAgyRoster(root));
    const out = mutate(doc);
    const file = agyAccountsFile(root);
    reverse.record(file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(out.doc, null, 2)}\n`);
    return out.result;
  });
}

export function agySidecars(root: string, slot: string): string[] {
  return [path.join(agyDir(root), `account-${slot}.json`), path.join(agyDir(root), `usage-${slot}.json`)];
}

export function dropAgySidecars(root: string, reverse: ReverseLog, slot: string): void {
  for (const file of agySidecars(root, slot)) {
    try {
      if (!fs.statSync(file).isFile()) continue;
    } catch {
      continue;
    }
    reverse.record(file);
    fs.unlinkSync(file);
  }
}
