/**
 * Locked roster store: resolve-validate-mutate spans with a reverse path.
 * Every `update*` call runs under `<root>/.lock`, re-reads the doc inside
 * the lock, validates with zod at the file boundary, applies a pure
 * mutation, records the prior bytes in the `ReverseLog`, and writes
 * atomically. Per-slot backup renames (swap/move) record each touched file
 * so rollback restores the pre-mutation layout.
 */

import fs from "node:fs";
import path from "node:path";
import {
  atomicWriteFile,
  atomicWriteJson,
  ReverseLog,
  withFileLock,
} from "../../platform/domain/atomicFile.js";
import { readJsonFile } from "../../platform/domain/jsonFile.js";
import { backupRoot } from "../../platform/domain/paths.js";
import {
  type AgyAccounts,
  agyAccountsSchema,
  type ClaudeSequence,
  claudeSequenceSchema,
  type CodexSequence,
  codexSequenceSchema,
} from "../domain/sequence.js";

export interface UpdateReceipt {
  reverse: ReverseLog;
  changed: string[];
}

function recordIfExists(reverse: ReverseLog, filePath: string): void {
  reverse.record(filePath);
}

function claudeSequencePath(root: string): string {
  return path.join(root, "sequence.json");
}

function codexSequencePath(root: string): string {
  return path.join(root, "codex", "sequence.json");
}

function agyAccountsPath(root: string): string {
  return path.join(root, "agy", "accounts.json");
}

/** Locked read-modify-write of `sequence.json` with zod + reverse. */
export function updateClaudeSequence(
  root: string,
  reverse: ReverseLog,
  mutate: (seq: ClaudeSequence) => { seq: ClaudeSequence; changed: string[]; note: string },
): { seq: ClaudeSequence; changed: string[]; note: string } {
  return withFileLock(root, () => {
    const file = claudeSequencePath(root);
    const raw = readJsonFile(file);
    if (raw === null) {
      throw new ConfigError("No accounts are managed yet");
    }
    const seq = claudeSequenceSchema.parse(raw) as ClaudeSequence;
    const out = mutate(structuredClone(seq));
    recordIfExists(reverse, file);
    atomicWriteJson(file, out.seq);
    return out;
  });
}

import { ConfigError } from "../../platform/domain/errors.js";

export function readClaudeSequenceOrThrow(root: string): ClaudeSequence {
  const raw = readJsonFile(claudeSequencePath(root));
  if (raw === null) throw new ConfigError("No accounts are managed yet");
  return claudeSequenceSchema.parse(raw) as ClaudeSequence;
}

export function readCodexSequenceOrThrow(root: string): CodexSequence {
  const raw = readJsonFile(codexSequencePath(root));
  if (raw === null) throw new ConfigError("No Codex accounts are managed yet");
  return codexSequenceSchema.parse(raw) as CodexSequence;
}

export function readAgyAccountsOrThrow(root: string): AgyAccounts {
  const raw = readJsonFile(agyAccountsPath(root));
  if (raw === null) throw new ConfigError("No Antigravity accounts are managed yet");
  return agyAccountsSchema.parse(raw) as AgyAccounts;
}

export function updateCodexSequence(
  root: string,
  reverse: ReverseLog,
  mutate: (seq: CodexSequence) => { seq: CodexSequence; changed: string[]; note: string },
): { seq: CodexSequence; changed: string[]; note: string } {
  return withFileLock(root, () => {
    const file = codexSequencePath(root);
    const seq = readCodexSequenceOrThrow(root);
    const out = mutate(structuredClone(seq));
    recordIfExists(reverse, file);
    atomicWriteJson(file, out.seq);
    return out;
  });
}

export function updateAgyAccounts(
  root: string,
  reverse: ReverseLog,
  mutate: (doc: AgyAccounts) => { doc: AgyAccounts; changed: string[]; note: string },
): { doc: AgyAccounts; changed: string[]; note: string } {
  return withFileLock(root, () => {
    const file = agyAccountsPath(root);
    const doc = readAgyAccountsOrThrow(root);
    const out = mutate(structuredClone(doc));
    recordIfExists(reverse, file);
    atomicWriteJson(file, out.doc);
    return out;
  });
}

/** Locked raw-file helper: record reverse, then atomically replace bytes. */
export function reverseWriteFile(
  root: string,
  reverse: ReverseLog,
  filePath: string,
  text: string,
  mode?: number,
): void {
  recordIfExists(reverse, filePath);
  atomicWriteFile(filePath, text, mode);
}

/** Locked delete with reverse (restores bytes on rollback). */
export function reverseUnlink(root: string, reverse: ReverseLog, filePath: string): boolean {
  try {
    if (!fs.statSync(filePath).isFile()) return false;
  } catch {
    return false;
  }
  recordIfExists(reverse, filePath);
  fs.unlinkSync(filePath);
  return true;
}

export function resolveRoot(explicit?: string): string {
  return explicit ?? backupRoot();
}
