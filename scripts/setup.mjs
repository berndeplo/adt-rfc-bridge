#!/usr/bin/env node
// adt-rfc-bridge setup: locate the SAP JCo libraries inside the user's Eclipse
// ADT install and copy them into ./jco-libs (gitignored). JCo is licensed and
// not redistributable, so we copy it from the user's own ADT rather than ship it.
import {
  readdirSync, existsSync, mkdirSync, copyFileSync, statSync, readFileSync, writeFileSync, chmodSync,
  unlinkSync,
} from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { inflateRawSync } from 'node:zlib';
import {
  getEclipsePaths, getPlatformPrefix, getNativeLibName, detectJCoLibraries,
} from './jco-detect.mjs';

// Extract one entry (matched by basename) from a zip/jar into destPath, using
// only Node built-ins so the repo stays dependency-free. Parses the End-Of-
// Central-Directory record, walks the central directory, then reads the entry's
// local header to locate and inflate its data. Returns true if extracted.
function extractZipEntryByBasename(zipPath, name, destPath) {
  const buf = readFileSync(zipPath);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error(`No end-of-central-directory record in ${zipPath}`);
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error(`Corrupt central directory in ${zipPath}`);
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const entryName = buf.toString('utf8', off + 46, off + 46 + nameLen);
    off += 46 + nameLen + extraLen + commentLen;
    if (entryName.split('/').pop() !== name) continue;
    if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error(`Corrupt local header in ${zipPath}`);
    const dataStart = localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28);
    if (method !== 0 && method !== 8) {
      // Anything else would silently write garbage and still report success.
      throw new Error(`Unsupported compression method ${method} for ${name} in ${zipPath}`);
    }
    const comp = buf.subarray(dataStart, dataStart + compSize);
    writeFileSync(destPath, method === 0 ? comp : inflateRawSync(comp));
    return true;
  }
  return false;
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const jcoLibsDir = join(repoRoot, 'jco-libs');

function fail(msg) {
  process.stderr.write(`\n[setup] ${msg}\n`);
  process.exit(1);
}

// Honors JAVA the same way bridge.mjs does, so setup doesn't validate one binary
// while the bridge runs another. Returns {version} or {error} — a broken shim
// (java on PATH pointing at a removed JDK) exits non-zero with a message worth
// showing, rather than being reported as "not found".
function checkJava() {
  const bin = process.env.JAVA || 'java';
  try {
    const out = execSync(`"${bin}" -version 2>&1`, { encoding: 'utf8' });
    const v = out.match(/version "([^"]+)"/);
    return v ? { version: v[1] } : { unparseable: out.trim().split('\n')[0] };
  } catch (err) {
    return { error: (err.stdout || err.stderr || err.message || '').toString().trim().split('\n')[0] };
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

// 2. Copy both jars into ./jco-libs, replacing any earlier JCo version.
// bridge.mjs puts *every* jar in jco-libs on the classpath, so leaving 3.1.12
// next to a freshly copied 3.1.13 loads two JCos — and the single extracted
// libsapjco3 can only match one of them. Observed after an Eclipse update.
mkdirSync(jcoLibsDir, { recursive: true });
const pruned = [];
for (const f of readdirSync(jcoLibsDir)) {
  if (f.startsWith('com.sap.conn.jco') && f.endsWith('.jar') && f !== found.jcoJar && f !== found.nativeJar) {
    unlinkSync(join(jcoLibsDir, f));
    pruned.push(f);
  }
}
for (const jar of [found.jcoJar, found.nativeJar]) {
  copyFileSync(join(found.dir, jar), join(jcoLibsDir, jar));
}

// 2b. Extract the native JCo shared library out of the platform fragment jar.
// The JVM's native loader needs it as a loose file on java.library.path; the
// jars alone produce "UnsatisfiedLinkError: no sapjco3 in java.library.path".
const nativeLibName = getNativeLibName();
const nativeLibPath = join(jcoLibsDir, nativeLibName);
let extracted;
try {
  extracted = extractZipEntryByBasename(join(found.dir, found.nativeJar), nativeLibName, nativeLibPath);
} catch (err) {
  fail(`Could not read ${found.nativeJar}: ${err.message}. `
     + 'The JCo jar in your Eclipse install may be corrupt or truncated — re-download ADT, '
     + 'then re-run `npm run setup`.');
}
if (!extracted) {
  fail(`Could not find ${nativeLibName} inside ${found.nativeJar}. `
     + 'The JCo platform fragment may be for a different OS/architecture.');
}
// A zero-byte result would pass every check here and only surface much later as
// a JVM UnsatisfiedLinkError.
if (statSync(nativeLibPath).size === 0) {
  fail(`Extracted ${nativeLibName} is empty — ${found.nativeJar} looks corrupt.`);
}

// 3. Java check (warn-only; bridge needs a runtime, not a JDK).
const java = checkJava();

// 4. Scaffold .env from .env.example if absent.
const envPath = join(repoRoot, '.env');
const envExample = join(repoRoot, '.env.example');
let scaffolded = false;
if (!existsSync(envPath) && existsSync(envExample)) {
  copyFileSync(envExample, envPath);
  try {
    chmodSync(envPath, 0o600); // it is about to hold a SAP password
  } catch {
    // Best-effort: filesystems without POSIX permissions must not abort a setup
    // whose actual work is already done.
  }
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
process.stdout.write(`${ok(`Extracted ${nativeLibName} -> jco-libs/`)}\n`);
if (pruned.length) {
  process.stdout.write(`${ok(`Removed stale JCo jar(s): ${pruned.join(', ')}`)}\n`);
}
// An unparseable version must never print a green check: Number('unknown') is
// NaN, so the old `javaMajor < 21` test was false and a Java 11 with an unusual
// -version format sailed through, failing later as UnsupportedClassVersionError.
const javaMajor = java.version ? Number(java.version.split('.')[0]) : NaN;
process.stdout.write(
  java.error
    ? `${warn(`Java not usable: ${java.error} — install a JRE/JDK 21+ before \`npm start\`.`)}\n`
    : java.unparseable
      ? `${warn(`Could not parse java -version ("${java.unparseable}") — ensure it is 21+.`)}\n`
      : javaMajor < 21
        ? `${warn(`Java ${java.version} detected — bridge requires 21+. Upgrade before \`npm start\`.`)}\n`
        : `${ok(`Java: ${java.version}`)}\n`,
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
