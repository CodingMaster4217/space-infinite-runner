#!/usr/bin/env node
/**
 * Parses every ES module in the project with `node --check`.
 * Catches syntax errors before a browser is ever opened.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIRS = ['src', 'scripts'];

const files = [];
for (const dir of DIRS) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) continue;
  for (const entry of fs.readdirSync(abs)) {
    if (entry.endsWith('.js')) files.push(path.join(dir, entry));
  }
}

let failed = 0;
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { cwd: ROOT, stdio: 'pipe' });
    process.stdout.write(`  ok   ${file}\n`);
  } catch (err) {
    failed += 1;
    process.stdout.write(`  FAIL ${file}\n`);
    process.stdout.write(`${err.stderr ? err.stderr.toString() : err.message}\n`);
  }
}

process.stdout.write(`\n${files.length - failed}/${files.length} modules parsed cleanly.\n`);
process.exit(failed === 0 ? 0 : 1);
