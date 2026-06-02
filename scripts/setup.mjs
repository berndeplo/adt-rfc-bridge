#!/usr/bin/env node
// adt-rfc-bridge setup: locate the SAP JCo libraries inside the user's Eclipse
// ADT install and copy them into ./jco-libs (gitignored). JCo is licensed and
// not redistributable, so we copy it from the user's own ADT rather than ship it.
import { readdirSync, existsSync, mkdirSync, copyFileSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import {
  getEclipsePaths, getPlatformPrefix, detectJCoLibraries,
} from './jco-detect.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const jcoLibsDir = join(repoRoot, 'jco-libs');

function fail(msg) {
  process.stderr.write(`\n[setup] ${msg}\n`);
  process.exit(1);
}

function checkJava() {
  try {
    const out = execSync('java -version 2>&1', { encoding: 'utf8' });
    const v = out.match(/version "([^"]+)"/);
    return v ? v[1] : 'unknown';
  } catch {
    return null;
  }
}

// 1. Detect JCo from Eclipse.
const prefix = getPlatformPrefix();
// ECLIPSE_HOME is already honored (and prioritized) inside getEclipsePaths().
const candidates = getEclipsePaths();
const found = detectJCoLibraries({
  dirs: candidates,
  readdir: (d) => readdirSync(d),
  exists: (d) => existsSync(d),
  prefix,
});

if (!found) {
  process.stderr.write('[setup] Searched these Eclipse plugin directories:\n');
  for (const d of candidates) process.stderr.write(`  - ${d}\n`);
  fail('Could not find SAP JCo libraries. Install Eclipse with ABAP Development '
     + 'Tools (ADT), or set ECLIPSE_HOME to your Eclipse install, then re-run `npm run setup`.');
}

// 2. Copy both jars into ./jco-libs.
mkdirSync(jcoLibsDir, { recursive: true });
for (const jar of [found.jcoJar, found.nativeJar]) {
  copyFileSync(join(found.dir, jar), join(jcoLibsDir, jar));
}

// 3. Java check (warn-only; bridge needs a runtime, not a JDK).
const java = checkJava();

// 4. Scaffold .env from .env.example if absent.
const envPath = join(repoRoot, '.env');
const envExample = join(repoRoot, '.env.example');
let scaffolded = false;
if (!existsSync(envPath) && existsSync(envExample)) {
  copyFileSync(envExample, envPath);
  scaffolded = true;
}

// 5. Locate the bundled proxy jar.
const proxyJar = join(repoRoot, 'jco-proxy.jar');

// 6. Summary.
const ok = (s) => `✓ ${s}`;
const warn = (s) => `⚠ ${s}`;
process.stdout.write('\nadt-rfc-bridge setup\n====================\n');
process.stdout.write(`${ok(`JCo found in: ${found.dir}`)}\n`);
process.stdout.write(`${ok(`Copied ${basename(found.jcoJar)} + ${basename(found.nativeJar)} (${found.architecture}) -> jco-libs/`)}\n`);
process.stdout.write(
  java ? `${ok(`Java: ${java}`)}\n`
       : `${warn('Java not found on PATH — install a JRE/JDK 21+ before `npm start`.')}\n`,
);
process.stdout.write(
  existsSync(proxyJar) ? `${ok(`jco-proxy.jar present (${(statSync(proxyJar).size / 1e6).toFixed(1)} MB)`)}\n`
                       : `${warn('jco-proxy.jar missing — rebuild via jco-proxy/README.md.')}\n`,
);
process.stdout.write(
  scaffolded ? `${ok('.env created from .env.example')}\n`
             : `${ok('.env already present (left untouched)')}\n`,
);
process.stdout.write('\nNext: edit .env (SAP host/user/password), then run `npm start`.\n\n');
