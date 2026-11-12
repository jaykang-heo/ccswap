/**
 * Golden parity: TS ported commands vs the Python CLI on shared fixtures.
 *
 * Goldens under tests-ts/golden/<fixture>/ are produced by
 * tests-ts/generate-goldens.py (real Python CLI, network blocked, fake HOME).
 * These tests run the TS implementation against the same fixture state and
 * compare stable projections. Volatile fields (`refreshedAt`, human
 * notes, capability mechanism prose) are excluded by design; see
 * docs/migration/behavior-matrix.md § "Wave-1 porting cut".
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { run } from '../src-ts/main.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, 'fixtures', 'basic');
const goldenDir = path.join(here, 'golden', 'basic');
const backupRoot = path.join(fixture, 'home', '.claude-swap-backup');

function golden(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(goldenDir, name), 'utf-8')) as unknown;
}

function goldenText(name: string): string {
  return fs.readFileSync(path.join(goldenDir, name), 'utf-8');
}

async function runTs(argv: string[]): Promise<{ code: number; stdout: string }> {
  const lines: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
  console.error = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
  let code = 0;
  try {
    code = await run(argv);
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return { code, stdout: `${lines.join('\n')}\n` };
}

beforeAll(() => {
  // Mirror the golden generator: the fixture home is HOME, so live-login
  // reads (`~/.claude.json`) and the backup root resolve inside the fixture.
  process.env['HOME'] = path.join(fixture, 'home');
  process.env['CCSWAP_BACKUP_ROOT'] = backupRoot;
  process.env['PATH'] = `${path.join(fixture, 'bin')}${path.delimiter}${process.env['PATH'] ?? ''}`;
  delete process.env['CLAUDE_CONFIG_DIR'];
});

type Loose = Record<string, unknown>;

function arr(v: unknown): Loose[] {
  return Array.isArray(v) ? (v as Loose[]) : [];
}

function record(v: unknown): Loose {
  return typeof v === 'object' && v !== null ? (v as Loose) : {};
}

function claudeProjection(entry: Loose): Loose {
  return {
    slot: String(entry['number'] ?? entry['slot']),
    email: entry['email'],
    alias: (entry['alias'] as string | undefined) ?? null,
    active: entry['active'],
  };
}

describe('claude roster parity', () => {
  for (const [goldenFile, argv] of [
    ['list-claude.json', ['list', '--json', '--provider', 'claude']],
    ['claude-list.json', ['claude', 'list', '--json']],
  ] as Array<[string, string[]]>) {
    it(`${argv.join(' ')} matches ${goldenFile} on roster fields`, async () => {
      const py = golden(goldenFile) as Loose;
      const { code, stdout } = await runTs(argv);
      expect(code).toBe(0);
      const ts = JSON.parse(stdout) as Loose;
      expect(arr(ts['accounts']).map(claudeProjection)).toEqual(arr(py['accounts']).map(claudeProjection));
      const pyActive: unknown = py['activeAccountNumber'];
      expect(ts['active']).toBe(typeof pyActive === 'number' ? String(pyActive) : null);
    });
  }

  it('status matches status.json (no live login -> active null)', async () => {
    const py = golden('status.json') as Loose;
    const { code, stdout } = await runTs(['status', '--json']);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual(py);
  });

  it('list --json (all providers) covers the same account emails', async () => {
    const py = golden('list.json') as Loose;
    const { code, stdout } = await runTs(['list', '--json']);
    expect(code).toBe(0);
    const ts = JSON.parse(stdout) as Loose;
    for (const provider of ['claude', 'codex', 'agy']) {
      const emails = (node: unknown): string[] =>
        arr(record(node)['accounts'])
          .map((a) => a['email'] ?? a['alias'])
          .filter((v): v is string => typeof v === 'string')
          .sort();
      expect(emails(ts[provider])).toEqual(emails(py[provider]));
    }
  });
});

describe('codex/agy roster parity', () => {
  it('codex list matches codex-list.json on roster fields', async () => {
    const py = golden('codex-list.json') as Loose;
    const { code, stdout } = await runTs(['codex', 'list', '--json']);
    expect(code).toBe(0);
    const ts = JSON.parse(stdout) as Loose;
    const proj = (a: Loose): Loose => {
      const num: unknown = a['number'] ?? a['slot'];
      return {
        slot: typeof num === 'number' ? String(num) : num,
        email: a['email'],
        active: a['active'],
      };
    };
    expect(arr(ts['accounts']).map(proj)).toEqual(arr(py['accounts']).map(proj));
  });

  it('agy list matches agy-list.json on roster fields', async () => {
    const py = golden('agy-list.json') as Loose;
    const { code, stdout } = await runTs(['agy', 'list', '--json']);
    expect(code).toBe(0);
    const ts = JSON.parse(stdout) as Loose;
    const proj = (a: Loose): Loose => {
      const num: unknown = a['number'] ?? a['slot'];
      return {
        slot: typeof num === 'number' ? String(num) : num,
        email: a['email'],
        active: a['active'],
      };
    };
    expect(arr(ts['accounts']).map(proj)).toEqual(arr(py['accounts']).map(proj));
  });

  it('agy status matches agy-status.json exactly', async () => {
    const py = golden('agy-status.json');
    const { code, stdout } = await runTs(['agy', 'status', '--json']);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual(py);
  });
});

describe('vendor roster parity', () => {
  for (const tool of ['muse', 'kiro']) {
    it(`${tool} list matches ${tool}-list.json on account fields`, async () => {
      const py = golden(`${tool}-list.json`) as Loose;
      const { code, stdout } = await runTs([tool, 'list', '--json']);
      expect(code).toBe(0);
      const ts = JSON.parse(stdout) as Loose;
      const proj = (a: Loose): Loose => ({
        alias: a['alias'],
        kind: a['kind'],
        provider: a['provider'],
        identity: a['identity'],
        active: a['active'],
      });
      expect(arr(ts['accounts']).map(proj)).toEqual(arr(py['accounts']).map(proj));
    });
  }

  it('vendors matches vendors.json on installed/accounts per tool', async () => {
    const py = golden('vendors.json') as Loose;
    const { code, stdout } = await runTs(['vendors', '--json']);
    expect(code).toBe(0);
    const ts = JSON.parse(stdout) as Loose;
    const norm = (v: Loose): Loose => ({
      tool: v['tool'],
      installed: v['installed'],
      accounts: typeof v['accounts'] === 'number' ? v['accounts'] : (v['accounts'] as unknown[]).length,
    });
    expect(arr(ts['vendors']).map(norm)).toEqual(arr(py['vendors']).map(norm));
  });

  it('vendors capabilities covers the same tools as Python', async () => {
    const py = golden('vendors-capabilities.json') as Loose;
    const { code, stdout } = await runTs(['vendors', 'capabilities', '--json']);
    expect(code).toBe(0);
    const ts = JSON.parse(stdout) as Loose;
    expect(Object.keys(record(ts['vendors'])).sort()).toEqual(Object.keys(record(py['vendors'])).sort());
  });
});

describe('usage parity', () => {
  it('usage --json covers the same tools and account aliases', async () => {
    const py = golden('usage.json') as Loose;
    const { code, stdout } = await runTs(['usage', '--json']);
    expect(code).toBe(0);
    const ts = JSON.parse(stdout) as Loose;
    const names = (node: unknown): string[] =>
      arr(node)
        .map((t) => t['tool'])
        .filter((v): v is string => typeof v === 'string');
    expect(names(ts['tools'])).toEqual(names(py['tools']));
    for (const t of arr(ts['tools'])) {
      const pyTool = arr(py['tools']).find((x) => x['tool'] === t['tool']);
      const aliases = (list: unknown): string[] =>
        arr(list)
          .map((a) => a['alias'] ?? a['email'])
          .filter((v): v is string => typeof v === 'string')
          .sort();
      expect(aliases(t['accounts'])).toEqual(aliases(record(pyTool)['accounts']));
    }
  });

  it('usage serves the stored vendor cache verbatim (Python cache oracle)', async () => {
    const oracle = golden('vendor-cache.json') as Record<string, Loose | null>;
    const { code, stdout } = await runTs(['usage', 'muse', '--json']);
    expect(code).toBe(0);
    const ts = JSON.parse(stdout) as Loose;
    for (const t of arr(ts['tools'])) {
      for (const a of arr(t['accounts'])) {
        const key = `${String(t['tool'])}\u001f${String(a['alias'])}`;
        const expected = oracle[key];
        expect(expected, `oracle entry for ${key}`).not.toBeNull();
        for (const field of ['state', 'windows', 'plan', 'source', 'attributedTo']) {
          expect(a[field], `${key}.${field}`).toEqual(expected?.[field]);
        }
      }
    }
  });
});

describe('config parity', () => {
  it('config list matches config-list.json exactly', async () => {
    const py = golden('config-list.json') as Loose;
    const { code, stdout } = await runTs(['config', 'list', '--json']);
    expect(code).toBe(0);
    const ts = JSON.parse(stdout) as Loose;
    expect(ts['settings']).toEqual(py['settings']);
  });

  it('config get matches config-get.json on key/value/isSet', async () => {
    const py = golden('config-get.json') as Loose;
    const { code, stdout } = await runTs(['config', 'get', 'autoswitch.threshold', '--json']);
    expect(code).toBe(0);
    const ts = JSON.parse(stdout) as Loose;
    expect({ key: ts['key'], value: ts['value'], isSet: ts['isSet'] }).toEqual({
      key: py['key'],
      value: py['value'],
      isSet: py['isSet'],
    });
  });
});

describe('human output parity', () => {
  it('alias matches alias.txt byte-for-byte', async () => {
    const { code, stdout } = await runTs(['alias']);
    expect(code).toBe(0);
    expect(stdout).toBe(goldenText('alias.txt'));
  });

  it('map matches map.txt byte-for-byte', async () => {
    const { code, stdout } = await runTs(['map']);
    expect(code).toBe(0);
    expect(stdout).toBe(goldenText('map.txt'));
  });
});
