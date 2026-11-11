/** Locked mapping store: reads/writes `<backup>/mappings.json` with reverse. */

import fs from "node:fs";
import path from "node:path";
import { ReverseLog, withFileLock } from "../../platform/domain/atomicFile.js";
import { readJsonFile } from "../../platform/domain/jsonFile.js";
import { backupRoot } from "../../platform/domain/paths.js";
import { type MappingsDoc, mappingsDocSchema } from "../domain/mappingDoc.js";

export function mappingsPath(root: string = backupRoot()): string {
  return path.join(root, "mappings.json");
}

export function loadMappings(root: string = backupRoot()): MappingsDoc {
  const raw = readJsonFile(mappingsPath(root));
  if (raw === null) return { schemaVersion: 1, mappings: {} };
  try {
    return mappingsDocSchema.parse(raw);
  } catch {
    return { schemaVersion: 1, mappings: {} };
  }
}

export function updateMappings<T>(
  root: string,
  reverse: ReverseLog,
  mutate: (doc: MappingsDoc) => { doc: MappingsDoc; note: string; result: T },
): { note: string; result: T } {
  return withFileLock(root, () => {
    const doc = loadMappings(root);
    const out = mutate(structuredClone(doc));
    const file = mappingsPath(root);
    reverse.record(file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(out.doc, null, 2)}\n`);
    return { note: out.note, result: out.result };
  });
}
