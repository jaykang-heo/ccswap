/** Zod file-boundary tests: corrupt/missing state degrades, never throws. */

import { describe, expect, it } from 'vitest';
import { effectiveSettings, SETTING_SPECS } from '../src-ts/config/domain/settings.js';
import { normalizeClaude } from '../src-ts/accounts/adapters/roster.js';
import { claudeSequenceSchema } from '../src-ts/accounts/domain/sequence.js';
import { vendorUsageCacheSchema } from '../src-ts/usage/domain/usageCache.js';
import { parseVendorAccounts, vendorsDocSchema } from '../src-ts/vendors/domain/vendorsDoc.js';

describe('sequence schema', () => {
  it('fills defaults for sparse records', () => {
    const parsed = claudeSequenceSchema.parse({ accounts: { '1': { email: 'a@x.com' } } });
    expect(parsed.accounts['1']?.disabled).toBe(false);
    expect(parsed.sequence).toEqual([]);
    expect(parsed.activeAccountNumber).toBeNull();
  });

  it('normalizeClaude marks only the live slot active', () => {
    const seq = claudeSequenceSchema.parse({
      accounts: { '1': { email: 'a@x.com' }, '2': { email: 'b@x.com' } },
      sequence: [1, 2],
      activeAccountNumber: 1,
    });
    const out = normalizeClaude(seq, null);
    expect(out.map((a) => a.active)).toEqual([false, false]);
    expect(normalizeClaude(seq, '2').map((a) => a.active)).toEqual([false, true]);
  });

  it('corrupt roster input throws at parse (adapters convert to empty)', () => {
    expect(() => claudeSequenceSchema.parse({ accounts: [1, 2] })).toThrow();
  });
});

describe('vendors schema', () => {
  it('skips corrupt entries but keeps good ones', () => {
    const out = parseVendorAccounts([
      { alias: 'work', kind: 'api-key' },
      { alias: 'bad alias!!', kind: 'api-key' },
      { kind: 'api-key' },
      'nope',
      { alias: 'ok2', kind: 'login', secretRef: 'muse-nothex' },
    ]);
    expect(out.map((a) => a.alias)).toEqual(['work']);
  });

  it('rejects newer schema versions at the adapter (done by caller)', () => {
    const doc = vendorsDocSchema.parse({ schemaVersion: 99, tools: {} });
    expect(doc.schemaVersion).toBe(99);
  });
});

describe('usage cache schema', () => {
  it('accepts camelCase UsageResult.to_json shape', () => {
    const key = 'muse\u001fwork';
    const parsed = vendorUsageCacheSchema.parse({
      schemaVersion: 1,
      entries: {
        [key]: {
          state: 'available',
          windows: [{ key: 'five-hour', usedPercent: 1.5, resetsAt: 1893456000 }],
        },
      },
    });
    const entry = parsed.entries[key];
    expect(entry?.state).toBe('available');
    expect(entry?.windows[0]?.key).toBe('five-hour');
  });

  it('corrupt cache parses to empty entries', () => {
    expect(vendorUsageCacheSchema.parse({ schemaVersion: 1 }).entries).toEqual({});
  });
});

describe('settings', () => {
  it('registry has one row per documented key', () => {
    expect(SETTING_SPECS.length).toBe(24);
    expect(new Set(SETTING_SPECS.map((s) => s.dotted)).size).toBe(24);
  });

  it('missing file degrades to defaults, nothing set', () => {
    const rows = effectiveSettings(undefined);
    expect(rows).toHaveLength(24);
    expect(rows.filter((r) => r.isSet)).toHaveLength(0);
    expect(rows.find((r) => r.key === 'autoswitch.threshold')?.value).toBe(90);
  });

  it('garbage values clamp to defaults but stay marked set', () => {
    const rows = effectiveSettings({ autoswitch: { threshold: 'lots', strategy: 'warp' } });
    expect(rows.find((r) => r.key === 'autoswitch.threshold')).toEqual({
      key: 'autoswitch.threshold',
      value: 90,
      isSet: true,
    });
    expect(rows.find((r) => r.key === 'autoswitch.strategy')?.value).toBe('best');
  });

  it('explicit values pass through', () => {
    const rows = effectiveSettings({ autoswitch: { threshold: 80 }, ui: { theme: 'dark' } });
    expect(rows.find((r) => r.key === 'autoswitch.threshold')).toEqual({
      key: 'autoswitch.threshold',
      value: 80,
      isSet: true,
    });
  });

  it('action keys report false/unset (live plugin state stays in Python)', () => {
    const rows = effectiveSettings({ claude: { statusline: true } });
    expect(rows.find((r) => r.key === 'claude.statusline')).toEqual({
      key: 'claude.statusline',
      value: false,
      isSet: false,
    });
  });
});
