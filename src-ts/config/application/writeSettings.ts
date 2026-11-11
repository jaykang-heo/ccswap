/**
 * Application: `config set` / `config unset`.
 * Strict parse (Python `parse_setting_value` parity): out-of-range or
 * mistyped values raise instead of clamping. Action keys
 * (`claude.statusline`, `claude.mod`) run install/uninstall in Python, so
 * they report `handled: false` and the dispatcher falls through.
 * A corrupt settings.json errors on the write path (never read-modify-write
 * from `{}` over a hand-recoverable file). Every write has a reverse entry.
 */

import fs from "node:fs";
import path from "node:path";
import { ReverseLog } from "../../platform/domain/atomicFile.js";
import { ConfigError } from "../../platform/domain/errors.js";
import { ACTION_KEYS, effectiveValue, SETTING_SPECS, type SettingSpec } from "../domain/settings.js";
import { failed, ok, unhandled, type UseCaseResult } from "../../accounts/application/manageAccounts.js";
import { backupRoot } from "../../platform/domain/paths.js";

const BOOL_WORDS: Record<string, boolean> = {
  true: true, "1": true, yes: true, on: true,
  false: false, "0": false, no: false, off: false,
};

export function parseSettingValue(spec: SettingSpec, rawValue: string): unknown {
  if (spec.kind === "bool") {
    const parsed = BOOL_WORDS[rawValue.trim().toLowerCase()];
    if (parsed === undefined) {
      throw new ConfigError(
        `${spec.dotted} expects true or false (or 1/0, yes/no, on/off), got '${rawValue}'`,
      );
    }
    return parsed;
  }
  if (spec.kind === "choice") {
    if (!spec.choices.includes(rawValue)) {
      throw new ConfigError(`${spec.dotted} must be one of: ${spec.choices.join(", ")}`);
    }
    return rawValue;
  }
  if (spec.kind === "string") {
    const value = rawValue.trim();
    if (value === "") {
      throw new ConfigError(
        `${spec.dotted} expects a non-empty value; use 'ccswap config unset ${spec.dotted}' to clear it`,
      );
    }
    return value;
  }
  if (spec.kind === "model_thresholds") {
    return parseModelThresholdsStrict(spec, rawValue);
  }
  const kind = spec.kind === "optional_float" ? "float" : spec.kind;
  const num = kind === "int" ? Number.parseInt(rawValue, 10) : Number(rawValue);
  if (!Number.isFinite(num) || (kind === "int" && !Number.isInteger(Number(rawValue)))) {
    const noun = kind === "int" ? "an integer" : "a number";
    const hint = spec.default === null ? `; use 'ccswap config unset ${spec.dotted}' to clear it` : "";
    throw new ConfigError(`${spec.dotted} expects ${noun}, got '${rawValue}'${hint}`);
  }
  const lo = spec.lo ?? -Infinity;
  const hi = spec.hi ?? Infinity;
  if (num < lo || num > hi) {
    throw new ConfigError(`${spec.dotted} must be between ${String(lo)} and ${String(hi)}`);
  }
  return num;
}

function parseModelThresholdsStrict(spec: SettingSpec, rawValue: string): string {
  // "Fable=40, Opus=70": names non-empty, values in the per-gate bounds.
  const parts = rawValue.split(",").map((p) => p.trim()).filter((p) => p !== "");
  if (parts.length === 0) throw new ConfigError(`${spec.dotted} expects e.g. 'Fable=40'`);
  const lo = 1;
  const hi = 99.9;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq < 0) throw new ConfigError(`${spec.dotted}: bad pair '${part}' (want Name=percent)`);
    const name = part.slice(0, eq).trim();
    const num = Number(part.slice(eq + 1).trim());
    if (name === "" || !Number.isFinite(num) || num < lo || num > hi) {
      throw new ConfigError(`${spec.dotted}: bad pair '${part}' (want Name=percent in ${String(lo)}..${String(hi)})`);
    }
    const key = name.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(`${name}=${part.slice(eq + 1).trim()}`);
    }
  }
  return out.join(",");
}

export function settingsPathFor(root: string): string {
  return path.join(root, "settings.json");
}

/** Raw read for the write path: corrupt errors, missing → {}. */
function readRawForWrite(file: string): Record<string, unknown> {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new ConfigError(`could not read ${file}: ${(err as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (err) {
    throw new ConfigError(`${file} is not valid JSON (${(err as Error).message}); fix or delete it before changing settings`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError(`${file} is not a JSON object; fix or delete it before changing settings`);
  }
  return raw as Record<string, unknown>;
}

export function configSet(
  root: string = backupRoot(),
  dottedKey: string,
  rawValue: string,
): UseCaseResult {
  try {
    const spec = SETTING_SPECS.find((s) => s.dotted === dottedKey);
    if (!spec) {
      return { code: 2, message: `unknown setting '${dottedKey}'`, reverse: new ReverseLog(), handled: true };
    }
    if (ACTION_KEYS.has(spec.dotted)) {
      return unhandled(`${spec.dotted} runs install/uninstall instead of writing`);
    }
    const value = parseSettingValue(spec, rawValue);
    const reverse = new ReverseLog();
    const file = settingsPathFor(root);
    const raw = readRawForWrite(file);
    raw["schemaVersion"] = typeof raw["schemaVersion"] === "number" ? raw["schemaVersion"] : 1;
    const section = typeof raw[spec.section] === "object" && raw[spec.section] !== null
      ? { ...(raw[spec.section] as Record<string, unknown>) }
      : {};
    section[spec.jsonKey] = value;
    raw[spec.section] = section;
    reverse.record(file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`);
    void effectiveValue;
    return ok(`Set ${spec.dotted} = ${JSON.stringify(value)}`, { key: spec.dotted, value }, reverse);
  } catch (err) {
    return failed(err);
  }
}

export function configUnset(root: string = backupRoot(), dottedKey: string): UseCaseResult {
  try {
    const spec = SETTING_SPECS.find((s) => s.dotted === dottedKey);
    if (!spec) {
      return { code: 2, message: `unknown setting '${dottedKey}'`, reverse: new ReverseLog(), handled: true };
    }
    if (ACTION_KEYS.has(spec.dotted)) {
      return unhandled(`${spec.dotted} runs install/uninstall instead of writing`);
    }
    const reverse = new ReverseLog();
    const file = settingsPathFor(root);
    const raw = readRawForWrite(file);
    const section = raw[spec.section];
    if (typeof section !== "object" || section === null || !((section as Record<string, unknown>)[spec.jsonKey] !== undefined)) {
      return ok(`${spec.dotted} was not set`, { key: spec.dotted, removed: false }, reverse);
    }
    const { [spec.jsonKey]: _removedKey, ...next } = section as Record<string, unknown>;
    void _removedKey;
    const out: Record<string, unknown> = { ...raw, schemaVersion: typeof raw["schemaVersion"] === "number" ? raw["schemaVersion"] : 1 };
    if (Object.keys(next).length === 0) {
      const { [spec.section]: _removedSection, ...rest } = out;
      void _removedSection;
      reverse.record(file);
      fs.writeFileSync(file, `${JSON.stringify(rest, null, 2)}\n`);
    } else {
      out[spec.section] = next;
      reverse.record(file);
      fs.writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
    }
    return ok(`Unset ${spec.dotted}`, { key: spec.dotted, removed: true }, reverse);
  } catch (err) {
    return failed(err);
  }
}
