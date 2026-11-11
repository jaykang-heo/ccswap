/** Locked Codex store: `codex/sequence.json` + `codex/auth-<slot>.json`. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ReverseLog, withFileLock } from "../../platform/domain/atomicFile.js";
import { readJsonFile } from "../../platform/domain/jsonFile.js";
import { backupRoot } from "../../platform/domain/paths.js";
import { type CodexSequence, codexSequenceSchema } from "../../accounts/domain/sequence.js";
import { ConfigError } from "../../platform/domain/errors.js";

export function codexHome(): string {
  return process.env["CODEX_HOME"] ?? path.join(os.homedir(), ".codex");
}

export function codexLiveAuthPath(): string {
  return path.join(codexHome(), "auth.json");
}

export function codexBackupAuthPath(root: string, slot: string): string {
  return path.join(root, "codex", `auth-${slot}.json`);
}

export function codexSequenceFile(root: string = backupRoot()): string {
  return path.join(root, "codex", "sequence.json");
}

export function readCodexSequence(root: string): CodexSequence {
  const raw = readJsonFile(codexSequenceFile(root));
  if (raw === null) throw new ConfigError("No Codex accounts are managed yet");
  return codexSequenceSchema.parse(raw) as CodexSequence;
}

export function updateCodex<T>(
  root: string,
  reverse: ReverseLog,
  mutate: (seq: CodexSequence) => { seq: CodexSequence; result: T },
): T {
  return withFileLock(root, () => {
    const seq = structuredClone(readCodexSequence(root));
    const out = mutate(seq);
    const file = codexSequenceFile(root);
    reverse.record(file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(out.seq, null, 2)}\n`);
    return out.result;
  });
}

/** Session-home markers for a slot → the custody dance stays in Python. */
export function codexSlotHasSessions(root: string, slot: string): boolean {
  const sessions = path.join(root, "codex", "sessions");
  try {
    return fs.readdirSync(sessions).some((n) => n.startsWith(`${slot}-`));
  } catch {
    return false;
  }
}

export function readLiveCodexAuth(): string | null {
  try {
    return fs.readFileSync(codexLiveAuthPath(), "utf-8");
  } catch {
    return null;
  }
}
