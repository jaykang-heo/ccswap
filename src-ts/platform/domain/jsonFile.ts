/** Safe JSON file reads. Corrupt/unreadable state degrades to null (never throws). */

import fs from 'node:fs';

export function readJsonFile(filePath: string): unknown {
  try {
    if (fs.lstatSync(filePath).isSymbolicLink()) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
  } catch {
    return null;
  }
}

export function readTextFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}
