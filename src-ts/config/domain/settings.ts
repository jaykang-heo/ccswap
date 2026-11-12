/**
 * Settings domain. Mirrors `claude_swap/settings.py` read path:
 * - `settings.json` is camelCase sections; missing/corrupt file → defaults.
 * - `isSet` = key present in the raw file (even when clamped to default).
 * - action keys (`claude.statusline`, `claude.mod`) report Claude Code's
 *   live plugin state in Python; TS reports the stored default (false) and
 *   documents the deviation (see behavior-matrix open questions).
 */

import { z } from 'zod';

export interface SettingSpec {
  dotted: string;
  section: string;
  jsonKey: string;
  kind: 'float' | 'optional_float' | 'int' | 'bool' | 'choice' | 'string' | 'model_thresholds';
  lo: number | null;
  hi: number | null;
  choices: string[];
  default: unknown;
}

export const ACTION_KEYS = new Set(['claude.statusline', 'claude.mod']);

// Defaults dumped from Python `SETTING_SPECS` (registry order). If the
// Python registry changes, `tests-ts/golden/config-list.json` (generated
// from Python) fails and this table must be updated.
export const SETTING_SPECS: SettingSpec[] = [
  {
    dotted: 'autoswitch.threshold',
    section: 'autoswitch',
    jsonKey: 'threshold',
    kind: 'float',
    lo: 50,
    hi: 99.9,
    choices: [],
    default: 90,
  },
  {
    dotted: 'autoswitch.weeklyThreshold',
    section: 'autoswitch',
    jsonKey: 'weeklyThreshold',
    kind: 'optional_float',
    lo: 50,
    hi: 99.9,
    choices: [],
    default: null,
  },
  {
    dotted: 'autoswitch.intervalSeconds',
    section: 'autoswitch',
    jsonKey: 'intervalSeconds',
    kind: 'float',
    lo: 15,
    hi: 3600,
    choices: [],
    default: 60,
  },
  {
    dotted: 'autoswitch.warmupFiveHour',
    section: 'autoswitch',
    jsonKey: 'warmupFiveHour',
    kind: 'bool',
    lo: null,
    hi: null,
    choices: [],
    default: false,
  },
  {
    dotted: 'autoswitch.cooldownSeconds',
    section: 'autoswitch',
    jsonKey: 'cooldownSeconds',
    kind: 'float',
    lo: 0,
    hi: 86400,
    choices: [],
    default: 300,
  },
  {
    dotted: 'autoswitch.hysteresisPct',
    section: 'autoswitch',
    jsonKey: 'hysteresisPct',
    kind: 'float',
    lo: 0,
    hi: 50,
    choices: [],
    default: 10,
  },
  {
    dotted: 'autoswitch.strategy',
    section: 'autoswitch',
    jsonKey: 'strategy',
    kind: 'choice',
    lo: null,
    hi: null,
    choices: ['best', 'consume-first'],
    default: 'best',
  },
  {
    dotted: 'autoswitch.includeApiKeyAccounts',
    section: 'autoswitch',
    jsonKey: 'includeApiKeyAccounts',
    kind: 'bool',
    lo: null,
    hi: null,
    choices: [],
    default: false,
  },
  {
    dotted: 'autoswitch.unhealthyTicks',
    section: 'autoswitch',
    jsonKey: 'unhealthyTicks',
    kind: 'int',
    lo: 1,
    hi: 100,
    choices: [],
    default: 3,
  },
  {
    dotted: 'autoswitch.model',
    section: 'autoswitch',
    jsonKey: 'model',
    kind: 'string',
    lo: null,
    hi: null,
    choices: [],
    default: null,
  },
  {
    dotted: 'autoswitch.windows',
    section: 'autoswitch',
    jsonKey: 'windows',
    kind: 'choice',
    lo: null,
    hi: null,
    choices: ['both', '5h', '7d'],
    default: 'both',
  },
  {
    dotted: 'autoswitch.threshold5h',
    section: 'autoswitch',
    jsonKey: 'threshold5h',
    kind: 'optional_float',
    lo: 1,
    hi: 99.9,
    choices: [],
    default: null,
  },
  {
    dotted: 'autoswitch.threshold7d',
    section: 'autoswitch',
    jsonKey: 'threshold7d',
    kind: 'optional_float',
    lo: 1,
    hi: 99.9,
    choices: [],
    default: null,
  },
  {
    dotted: 'autoswitch.modelThresholds',
    section: 'autoswitch',
    jsonKey: 'modelThresholds',
    kind: 'model_thresholds',
    lo: null,
    hi: null,
    choices: [],
    default: null,
  },
  {
    dotted: 'ui.language',
    section: 'ui',
    jsonKey: 'language',
    kind: 'choice',
    lo: null,
    hi: null,
    choices: ['en', 'de', 'el'],
    default: 'en',
  },
  {
    dotted: 'ui.theme',
    section: 'ui',
    jsonKey: 'theme',
    kind: 'choice',
    lo: null,
    hi: null,
    choices: ['dark', 'light', 'auto'],
    default: 'auto',
  },
  {
    dotted: 'ui.view',
    section: 'ui',
    jsonKey: 'view',
    kind: 'choice',
    lo: null,
    hi: null,
    choices: ['combined', 'claude', 'codex', 'agy'],
    default: 'combined',
  },
  {
    dotted: 'ui.mask',
    section: 'ui',
    jsonKey: 'mask',
    kind: 'bool',
    lo: null,
    hi: null,
    choices: [],
    default: false,
  },
  {
    dotted: 'ui.starPrompt',
    section: 'ui',
    jsonKey: 'starPrompt',
    kind: 'bool',
    lo: null,
    hi: null,
    choices: [],
    default: true,
  },
  {
    dotted: 'credentials.backend',
    section: 'credentials',
    jsonKey: 'backend',
    kind: 'choice',
    lo: null,
    hi: null,
    choices: ['auto', 'file'],
    default: 'auto',
  },
  {
    dotted: 'claude.statusline',
    section: 'claude',
    jsonKey: 'statusline',
    kind: 'bool',
    lo: null,
    hi: null,
    choices: [],
    default: false,
  },
  {
    dotted: 'claude.mod',
    section: 'claude',
    jsonKey: 'mod',
    kind: 'bool',
    lo: null,
    hi: null,
    choices: [],
    default: false,
  },
  {
    dotted: 'run.shareHistory',
    section: 'run',
    jsonKey: 'shareHistory',
    kind: 'bool',
    lo: null,
    hi: null,
    choices: [],
    default: false,
  },
  {
    dotted: 'updates.check',
    section: 'updates',
    jsonKey: 'check',
    kind: 'bool',
    lo: null,
    hi: null,
    choices: [],
    default: true,
  },
];

const rawDoc = z.record(z.string(), z.unknown());

function clampNum(value: unknown, lo: number, hi: number): number | null {
  if (typeof value === 'boolean') return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(Math.max(value, lo), hi);
}

export function effectiveValue(spec: SettingSpec, raw: unknown): unknown {
  if (ACTION_KEYS.has(spec.dotted)) return false;
  switch (spec.kind) {
    case 'float': {
      const v = clampNum(raw, spec.lo ?? -Infinity, spec.hi ?? Infinity);
      return v === null ? spec.default : v;
    }
    case 'optional_float': {
      if (raw === null || raw === undefined) return null;
      const v = clampNum(raw, spec.lo ?? -Infinity, spec.hi ?? Infinity);
      return v === null ? spec.default : v;
    }
    case 'int': {
      const v = clampNum(raw, spec.lo ?? -Infinity, spec.hi ?? Infinity);
      return v === null ? spec.default : Math.trunc(v);
    }
    case 'bool':
      return typeof raw === 'boolean' ? raw : spec.default;
    case 'choice':
      return typeof raw === 'string' && spec.choices.includes(raw) ? raw : spec.default;
    case 'string':
      return typeof raw === 'string' && raw !== '' ? raw : spec.default;
    case 'model_thresholds':
      return typeof raw === 'string' && raw.trim() !== '' ? raw : spec.default;
  }
}

export interface EffectiveRow {
  key: string;
  value: unknown;
  isSet: boolean;
}

export function effectiveSettings(rawFile: unknown): EffectiveRow[] {
  let doc: Record<string, unknown> = {};
  try {
    doc = rawDoc.parse(rawFile);
  } catch {
    doc = {};
  }
  return SETTING_SPECS.map((spec) => {
    const section = doc[spec.section];
    const present = typeof section === 'object' && section !== null && spec.jsonKey in section;
    const raw = present ? (section as Record<string, unknown>)[spec.jsonKey] : undefined;
    if (ACTION_KEYS.has(spec.dotted)) return { key: spec.dotted, value: false, isSet: false };
    return { key: spec.dotted, value: effectiveValue(spec, raw), isSet: present };
  });
}

export function formatSettingValue(value: unknown): string {
  if (value === null || value === undefined) return '(none)';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number' && Number.isInteger(value)) return String(value);
  if (typeof value === 'number' || typeof value === 'string') return String(value);
  const rendered: unknown = JSON.stringify(value);
  return typeof rendered === 'string' ? rendered : '(none)';
}
