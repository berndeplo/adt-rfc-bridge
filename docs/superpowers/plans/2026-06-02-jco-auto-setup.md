# JCo Auto-Setup + jco-proxy Vendoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a fresh clone of adt-rfc-bridge usable via `git clone` → `npm run setup` → edit `.env` → `npm start`, by auto-detecting the SAP JCo libraries from the user's local Eclipse ADT install and vendoring the owner's own `jco-proxy` (source + prebuilt jar).

**Architecture:** A dependency-free ESM setup script (`scripts/setup.mjs`) calls pure, unit-tested detection helpers (`scripts/jco-detect.mjs`) to locate the Eclipse `plugins/` dir, match the `com.sap.conn.jco_*.jar` + platform-native fragment, and copy both into a gitignored `./jco-libs/`. The `jco-proxy` Maven module is vendored as source plus a prebuilt fat-jar (built from that source; contains no licensed SAP bytes because `sapjco3` is `provided`). `bridge.mjs` gets minimal defaults so a fresh clone needs only SAP credentials in `.env`.

**Tech Stack:** Node 22+ (ESM, zero runtime deps), `node:test` + `node:assert` for tests, Java 21+ runtime, Maven (maintainer-only, for rebuilding the proxy jar).

---

## File Structure

- Create: `jco-proxy/pom.xml` + `jco-proxy/src/main/java/com/sap/mcp/proxy/**` (7 Java files) — vendored proxy source
- Create: `jco-proxy.jar` (repo root) — prebuilt fat-jar built from the vendored source
- Create: `jco-proxy/README.md` — rebuild instructions
- Create: `scripts/jco-detect.mjs` — pure detection helpers (no fs side effects beyond injected readers)
- Create: `scripts/jco-detect.test.mjs` — `node:test` unit tests for the helpers
- Create: `scripts/setup.mjs` — the `npm run setup` CLI (fs copy, env scaffold, java check, summary)
- Modify: `package.json` — add `"setup"` and `"test"` scripts
- Modify: `.gitignore` — add `jco-libs/`
- Modify: `bridge.mjs:134`, `bridge.mjs:152-156` — default `JCO_LIBS_DIR`, resolve proxy jar repo-root-first
- Modify: `.env.example` — point `JCO_LIBS_DIR` at `./jco-libs`
- Modify: `README.md` — installation flow, JCo acquisition section, accurate jco-proxy provenance

Source of truth for vendored files (this machine only):
`/Users/benjamin.bockmuehl/eclipse/Eclipse-MCP/mcp-abap-adt/jco-proxy/`

---

### Task 1: Vendor the jco-proxy source and pom

**Files:**
- Create: `jco-proxy/pom.xml`
- Create: `jco-proxy/src/main/java/com/sap/mcp/proxy/RfcProxyServer.java`
- Create: `jco-proxy/src/main/java/com/sap/mcp/proxy/JCoConnectionManager.java`
- Create: `jco-proxy/src/main/java/com/sap/mcp/proxy/RestRfcEndpointCaller.java`
- Create: `jco-proxy/src/main/java/com/sap/mcp/proxy/StatefulSessionManager.java`
- Create: `jco-proxy/src/main/java/com/sap/mcp/proxy/config/ConnectionConfig.java`
- Create: `jco-proxy/src/main/java/com/sap/mcp/proxy/model/ProxyRequest.java`
- Create: `jco-proxy/src/main/java/com/sap/mcp/proxy/model/ProxyResponse.java`

- [ ] **Step 1: Copy the module source tree**

```bash
SRC=/Users/benjamin.bockmuehl/eclipse/Eclipse-MCP/mcp-abap-adt/jco-proxy
mkdir -p jco-proxy
cp "$SRC/pom.xml" jco-proxy/pom.xml
mkdir -p jco-proxy/src/main/java/com/sap/mcp/proxy/config jco-proxy/src/main/java/com/sap/mcp/proxy/model
cp "$SRC/src/main/java/com/sap/mcp/proxy/"*.java               jco-proxy/src/main/java/com/sap/mcp/proxy/
cp "$SRC/src/main/java/com/sap/mcp/proxy/config/"*.java         jco-proxy/src/main/java/com/sap/mcp/proxy/config/
cp "$SRC/src/main/java/com/sap/mcp/proxy/model/"*.java          jco-proxy/src/main/java/com/sap/mcp/proxy/model/
```

- [ ] **Step 2: Verify the tree copied (8 files: pom + 7 java)**

Run: `find jco-proxy -type f \( -name '*.java' -o -name 'pom.xml' \) | sort`
Expected: exactly these 8 paths:
```
jco-proxy/pom.xml
jco-proxy/src/main/java/com/sap/mcp/proxy/JCoConnectionManager.java
jco-proxy/src/main/java/com/sap/mcp/proxy/RestRfcEndpointCaller.java
jco-proxy/src/main/java/com/sap/mcp/proxy/RfcProxyServer.java
jco-proxy/src/main/java/com/sap/mcp/proxy/StatefulSessionManager.java
jco-proxy/src/main/java/com/sap/mcp/proxy/config/ConnectionConfig.java
jco-proxy/src/main/java/com/sap/mcp/proxy/model/ProxyRequest.java
jco-proxy/src/main/java/com/sap/mcp/proxy/model/ProxyResponse.java
```

- [ ] **Step 3: Commit**

```bash
git add jco-proxy/pom.xml jco-proxy/src
git commit -m "Vendor jco-proxy Maven module source (own MIT code, sapjco3 provided)"
```

---

### Task 2: Build the prebuilt jar from the vendored source

**Files:**
- Create: `jco-proxy.jar` (repo root)

- [ ] **Step 1: Build the fat-jar from the vendored module**

`sapjco3:3.1.12` is `provided` and is already in `~/.m2/repository/com/sap/conn/jco/sapjco3/3.1.12/`, so compilation resolves without extra setup.

Run: `mvn -f jco-proxy/pom.xml clean package -q`
Expected: build SUCCESS; produces `jco-proxy/target/jco-proxy-1.0.0.jar`.

If the build fails with a missing `sapjco3` artifact, install it from the detected JCo jar first (one-time):
```bash
mvn install:install-file -DgroupId=com.sap.conn.jco -DartifactId=sapjco3 \
  -Dversion=3.1.12 -Dpackaging=jar \
  -Dfile="$HOME/eclipse/Eclipse.app/Contents/Eclipse/plugins/com.sap.conn.jco_3.1.12.jar"
```

- [ ] **Step 2: Place the built jar at repo root**

```bash
cp jco-proxy/target/jco-proxy-1.0.0.jar jco-proxy.jar
```

- [ ] **Step 3: Verify the jar has the right main class and NO licensed SAP classes**

Run: `unzip -p jco-proxy.jar META-INF/MANIFEST.MF | grep -i main-class`
Expected: `Main-Class: com.sap.mcp.proxy.RfcProxyServer`

Run: `unzip -l jco-proxy.jar | grep -c 'com/sap/conn/jco'`
Expected: `0`  (no licensed SAP JCo bytes inside)

- [ ] **Step 4: Ignore licensed libs + Maven output, then commit source-build artifacts**

Add ignore lines so the licensed SAP JCo libraries (`jco-libs/`) and Maven build
output (`jco-proxy/target/`) are never committed:
```bash
printf '\n# Setup-copied licensed SAP JCo libraries (never commit)\njco-libs/\n# Maven build output\njco-proxy/target/\n' >> .gitignore
git add .gitignore jco-proxy.jar
git commit -m "Add prebuilt jco-proxy.jar; gitignore jco-libs/ and maven target/"
```

---

### Task 3: Document how to rebuild the proxy jar

**Files:**
- Create: `jco-proxy/README.md`

- [ ] **Step 1: Write the rebuild doc**

```markdown
# jco-proxy

A small Java sidecar (`com.sap.mcp.proxy.RfcProxyServer`) that adt-rfc-bridge
spawns. It accepts `ProxyRequest` JSON envelopes over HTTP and invokes SAP's
`SADT_REST_RFC_ENDPOINT` function module over JCo/RFC, returning a
`ProxyResponse`.

This is original MIT-licensed code (see the repo `LICENSE`). The SAP JCo
dependency is scoped `provided`, so the built fat-jar contains **no** SAP JCo
bytes — JCo is supplied at runtime from the libraries `npm run setup` copies
into `../jco-libs/`.

## Rebuilding `jco-proxy.jar`

Requires JDK 21+ and Maven. SAP JCo (`sapjco3`) must be resolvable to the Maven
compiler. If it is not already in your local Maven repo, install it from the
JCo jar in your Eclipse ADT install (one-time):

    mvn install:install-file -DgroupId=com.sap.conn.jco -DartifactId=sapjco3 \
      -Dversion=3.1.12 -Dpackaging=jar \
      -Dfile=/path/to/Eclipse/plugins/com.sap.conn.jco_3.1.12.jar

Then build and refresh the committed jar:

    mvn -f pom.xml clean package
    cp target/jco-proxy-1.0.0.jar ../jco-proxy.jar
```

- [ ] **Step 2: Commit**

```bash
git add jco-proxy/README.md
git commit -m "Document how to rebuild jco-proxy.jar"
```

---

### Task 4: Pure JCo detection helpers (TDD)

**Files:**
- Create: `scripts/jco-detect.mjs`
- Test: `scripts/jco-detect.test.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
// scripts/jco-detect.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getPlatformPrefix,
  jcoJarRe,
  nativeJarRe,
  matchJcoJars,
} from './jco-detect.mjs';

test('platform prefix maps node platform to JCo fragment prefix', () => {
  assert.equal(getPlatformPrefix('darwin'), 'macosx');
  assert.equal(getPlatformPrefix('win32'), 'win32');
  assert.equal(getPlatformPrefix('linux'), 'linux');
  assert.throws(() => getPlatformPrefix('sunos'));
});

test('jco core jar regex matches the real bundle and rejects near-misses', () => {
  assert.ok(jcoJarRe.test('com.sap.conn.jco_3.1.12.jar'));
  assert.ok(!jcoJarRe.test('com.sap.conn.jco.eclipse_1.31.0.jar'));
  assert.ok(!jcoJarRe.test('com.sap.conn.jco.macosx.aarch64_3.1.12.jar'));
});

test('native fragment regex matches per platform/arch', () => {
  assert.ok(nativeJarRe('macosx').test('com.sap.conn.jco.macosx.aarch64_3.1.12.jar'));
  assert.ok(nativeJarRe('win32').test('com.sap.conn.jco.win32.x86_64_3.1.11.jar'));
  assert.ok(!nativeJarRe('macosx').test('com.sap.conn.jco_3.1.12.jar'));
});

test('matchJcoJars picks core + native + architecture from a file list', () => {
  const files = [
    'org.eclipse.foo_1.0.0.jar',
    'com.sap.conn.jco_3.1.12.jar',
    'com.sap.conn.jco.eclipse_1.31.0.jar',
    'com.sap.conn.jco.macosx.aarch64_3.1.12.jar',
  ];
  assert.deepEqual(matchJcoJars(files, 'macosx'), {
    jcoJar: 'com.sap.conn.jco_3.1.12.jar',
    nativeJar: 'com.sap.conn.jco.macosx.aarch64_3.1.12.jar',
    architecture: 'macosx.aarch64',
  });
});

test('matchJcoJars returns null when either jar is absent', () => {
  assert.equal(matchJcoJars(['com.sap.conn.jco_3.1.12.jar'], 'macosx'), null);
  assert.equal(matchJcoJars(['com.sap.conn.jco.macosx.aarch64_3.1.12.jar'], 'macosx'), null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test scripts/jco-detect.test.mjs`
Expected: FAIL — cannot find module `./jco-detect.mjs` (or export errors).

- [ ] **Step 3: Implement the helpers**

```javascript
// scripts/jco-detect.mjs
// Pure, side-effect-free helpers for locating SAP JCo libraries inside an
// Eclipse ADT installation. Filesystem access is injected so these stay unit
// testable; scripts/setup.mjs wires in the real fs.
import path from 'node:path';

// com.sap.conn.jco_3.1.12.jar  (the core bundle — NOT the .eclipse / .ui ones)
export const jcoJarRe = /^com\.sap\.conn\.jco_\d+\.\d+\.\d+\.jar$/;

// com.sap.conn.jco.macosx.aarch64_3.1.12.jar  (platform-native fragment)
export function nativeJarRe(prefix) {
  return new RegExp(`^com\\.sap\\.conn\\.jco\\.${prefix}\\.[a-z0-9_]+_\\d+\\.\\d+\\.\\d+\\.jar$`);
}

export function getPlatformPrefix(platform = process.platform) {
  switch (platform) {
    case 'darwin': return 'macosx';
    case 'win32': return 'win32';
    case 'linux': return 'linux';
    default: throw new Error(`Unsupported platform: ${platform}`);
  }
}

// Given a flat list of plugin filenames, return the JCo core + native jar names
// and the architecture string (e.g. "macosx.aarch64"), or null if either is missing.
export function matchJcoJars(files, prefix) {
  const jcoJar = files.find((f) => jcoJarRe.test(f));
  const nativeJar = files.find((f) => nativeJarRe(prefix).test(f));
  if (!jcoJar || !nativeJar) return null;
  const m = nativeJar.match(/^com\.sap\.conn\.jco\.([a-z0-9._]+?)_\d+\.\d+\.\d+\.jar$/i);
  return { jcoJar, nativeJar, architecture: m ? m[1] : 'unknown' };
}

// Candidate Eclipse plugin directories, highest priority first.
export function getEclipsePaths(env = process.env, platform = process.platform) {
  const out = [];
  if (env.ECLIPSE_HOME) out.push(path.join(env.ECLIPSE_HOME, 'plugins'));
  const home = platform === 'win32' ? env.USERPROFILE : env.HOME;
  if (home) out.push(path.join(home, '.p2', 'pool', 'plugins'));
  if (platform === 'darwin') {
    out.push('/Applications/Eclipse.app/Contents/Eclipse/plugins');
    out.push('/Applications/Eclipse ADT.app/Contents/Eclipse/plugins');
    if (home) {
      out.push(path.join(home, 'Applications/Eclipse.app/Contents/Eclipse/plugins'));
      out.push(path.join(home, 'eclipse/Eclipse.app/Contents/Eclipse/plugins'));
    }
  } else if (platform === 'win32') {
    out.push('C:\\Eclipse\\plugins', 'C:\\Program Files\\Eclipse\\plugins');
    if (env.USERPROFILE) out.push(path.join(env.USERPROFILE, 'Eclipse', 'plugins'));
    if (env.LOCALAPPDATA) out.push(path.join(env.LOCALAPPDATA, 'Eclipse', 'plugins'));
  } else {
    out.push('/opt/eclipse/plugins');
    if (home) out.push(path.join(home, 'eclipse/plugins'), path.join(home, '.eclipse/plugins'));
  }
  return out;
}

// Find the first candidate dir that contains both JCo jars.
// `readdir(dir) -> string[]` and `exists(dir) -> boolean` are injected.
export function detectJCoLibraries({ dirs, readdir, exists, prefix }) {
  for (const dir of dirs) {
    if (!exists(dir)) continue;
    const match = matchJcoJars(readdir(dir), prefix);
    if (match) return { dir, ...match };
  }
  return null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test scripts/jco-detect.test.mjs`
Expected: PASS — all 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/jco-detect.mjs scripts/jco-detect.test.mjs
git commit -m "Add tested, dependency-free JCo detection helpers"
```

---

### Task 5: The setup CLI

**Files:**
- Create: `scripts/setup.mjs`

- [ ] **Step 1: Implement the setup script**

```javascript
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
const candidates = process.env.ECLIPSE_HOME
  ? [join(process.env.ECLIPSE_HOME, 'plugins'), ...getEclipsePaths()]
  : getEclipsePaths();
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
```

- [ ] **Step 2: Run setup against the real Eclipse install**

Run: `node scripts/setup.mjs`
Expected: prints "JCo found in: …/Eclipse.app/Contents/Eclipse/plugins", copies two jars, reports Java 25, confirms `jco-proxy.jar` present, scaffolds or notes `.env`.

- [ ] **Step 3: Verify jco-libs contents**

Run: `ls jco-libs`
Expected: `com.sap.conn.jco_3.1.12.jar` and `com.sap.conn.jco.macosx.aarch64_3.1.12.jar`.

- [ ] **Step 4: Verify the failure path is explicit**

Run: `ECLIPSE_HOME=/tmp/nope node scripts/setup.mjs; echo "exit=$?"`
Expected: prints the searched-paths list and the "Could not find SAP JCo" message; `exit=1` (assuming no Eclipse at the standard fallback paths; if one exists, this step is informational only).

- [ ] **Step 5: Commit**

```bash
git add scripts/setup.mjs
git commit -m "Add npm run setup: auto-detect and copy JCo libs from Eclipse ADT"
```

---

### Task 6: Wire scripts into package.json

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add the setup and test scripts**

Change the `"scripts"` block from:
```json
  "scripts": {
    "start": "node --env-file=.env bridge.mjs"
  },
```
to:
```json
  "scripts": {
    "setup": "node scripts/setup.mjs",
    "start": "node --env-file=.env bridge.mjs",
    "test": "node --test scripts/"
  },
```

- [ ] **Step 2: Verify scripts run**

Run: `npm test`
Expected: the `node:test` suite passes (5 tests from Task 4).

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "Add setup and test npm scripts"
```

---

### Task 7: Minimal bridge.mjs defaults

**Files:**
- Modify: `bridge.mjs:134`, `bridge.mjs:152-156`

- [ ] **Step 1: Default JCO_LIBS_DIR to the repo-local jco-libs**

Change line 134 from:
```javascript
  jcoLibsDir: required('JCO_LIBS_DIR'),
```
to:
```javascript
  jcoLibsDir: getenv('JCO_LIBS_DIR', join(__dirname, 'jco-libs')),
```

- [ ] **Step 2: Resolve the proxy jar from the repo root first, then jco-libs**

Change lines 152-156 from:
```javascript
const proxyJar = join(cfg.jcoLibsDir, 'jco-proxy.jar');
if (!existsSync(proxyJar)) {
  log(`[bridge] jco-proxy.jar not found at: ${proxyJar}`);
  process.exit(2);
}
```
to:
```javascript
const proxyJarCandidates = [
  join(__dirname, 'jco-proxy.jar'),
  join(cfg.jcoLibsDir, 'jco-proxy.jar'),
];
const proxyJar = proxyJarCandidates.find((p) => existsSync(p));
if (!proxyJar) {
  log(`[bridge] jco-proxy.jar not found (looked in: ${proxyJarCandidates.join(', ')})`);
  process.exit(2);
}
```

- [ ] **Step 3: Verify the bridge resolves config without a JCO_LIBS_DIR override**

This confirms the defaulted `jcoLibsDir` and proxy-jar resolution are wired correctly. The process will exit 2 at the missing-required SAP vars (expected — we are only checking the new defaults don't crash earlier and the jco-libs path resolves).

Run: `node --env-file=/dev/null bridge.mjs 2>&1 | head -5 || true`
Expected: no "missing required env var: JCO_LIBS_DIR" line; instead it proceeds to the SAP-credential checks (e.g. `missing required env var: SAP_CLIENT`) or the jco-libs existence check — proving `JCO_LIBS_DIR` now has a default.

- [ ] **Step 4: Commit**

```bash
git add bridge.mjs
git commit -m "Default JCO_LIBS_DIR to ./jco-libs and resolve bundled jco-proxy.jar"
```

---

### Task 8: Point .env.example at ./jco-libs

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Update the JCO_LIBS_DIR line**

Change:
```
# Location of vsp's jco-libs directory.
# Must contain: jco-proxy.jar, com.sap.conn.jco_*.jar, com.sap.conn.jco.<platform>_*.jar, libsapjco3.dylib
JCO_LIBS_DIR=/path/to/mcp-abap-adt-vsp/jco-libs
```
to:
```
# JCo libraries directory. `npm run setup` populates ./jco-libs by copying the
# SAP JCo jars out of your local Eclipse ADT install. Leave this as-is unless
# your JCo libraries live elsewhere.
JCO_LIBS_DIR=./jco-libs
```

- [ ] **Step 2: Commit**

```bash
git add .env.example
git commit -m "Point JCO_LIBS_DIR at ./jco-libs populated by setup"
```

---

### Task 9: README rewrite

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Replace the Prereqs, Installation, and "Why this exists" sections**

Replace the current `## Prereqs` block with:
```markdown
## Prereqs

- Node 22+ (the bridge itself is dependency-free)
- Java 21+ runtime (Java 25 known to work; the proxy needs `--enable-native-access=ALL-UNNAMED`)
- Eclipse with ABAP Development Tools (ADT) installed locally — this is where
  `npm run setup` sources the SAP JCo libraries from (see below)
```

Replace the entire `## Installation` section with:
```markdown
## Installation

```sh
# 1. Clone
git clone https://github.com/berndeplo/adt-rfc-bridge.git
cd adt-rfc-bridge

# 2. Detect + copy the SAP JCo libraries from your Eclipse ADT install
npm run setup

# 3. Configure SAP connection
#    (setup already created .env from .env.example)
#    Edit .env: set SAP host/user/password. JCO_LIBS_DIR already points at ./jco-libs.

# 4. Run
npm start
```

`npm run setup` searches your Eclipse install (honoring `ECLIPSE_HOME` if set),
finds `com.sap.conn.jco_*.jar` plus the platform-native fragment for your OS, and
copies both into `./jco-libs/`. No npm dependencies are installed — the bridge
runs on Node built-ins only.

### How the JCo libraries are obtained

The SAP JCo libraries (`com.sap.conn.jco_*.jar` and the native `libsapjco3.*`
inside the platform fragment) are **licensed SAP binaries and are not
redistributable**, so this repo does not ship them. They are, however, bundled
inside every Eclipse ADT installation's `plugins/` directory (and downloadable
from SAP's "SAP Java Connector" area with an S-user). `npm run setup` copies them
out of your local ADT install into `./jco-libs/` (which is gitignored). The
correct native library for your platform is selected automatically; JCo 3.1
self-extracts it at runtime, so there is no manual `.dylib`/`.so`/`.dll` step.

If setup can't find them, install Eclipse ADT or set `ECLIPSE_HOME` to your
Eclipse directory and re-run `npm run setup`.

### About jco-proxy.jar

`jco-proxy.jar` (and its source in `jco-proxy/`) is bundled in this repo. It is
original MIT-licensed code that wraps SAP's `SADT_REST_RFC_ENDPOINT` over JCo;
its `sapjco3` dependency is `provided`, so the jar contains **no** licensed SAP
bytes. To rebuild it, see `jco-proxy/README.md`.
```

Replace the `## Why this exists` section with:
```markdown
## Why this exists

Some SAP systems are reachable only via RFC/SNC (no HTTP web dispatcher exposed
to the corporate network). [arc-1](https://github.com/marianfoo/arc-1) is
HTTP-only by design. This bridge runs a small JCo sidecar (`jco-proxy.jar`) so
the broader arc-1 toolchain works against RFC-only systems.
```

Also update the Prereqs link target: remove the `mcp-abap-adt-vsp` reference that
described where `jco-libs` came from (now covered by "How the JCo libraries are
obtained").

- [ ] **Step 2: Verify no stale vsp references remain**

Run: `grep -niE "mcp-abap-adt-vsp|vsp's|put-password-here" README.md || echo "clean"`
Expected: `clean` (the ecosystem-table row for mcp-abap-adt-vsp was already removed; this confirms no prose references linger).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "Rewrite README: setup-driven install and accurate JCo/jco-proxy sourcing"
```

---

### Task 10: Final verification

- [ ] **Step 1: Clean-clone simulation of setup**

```bash
rm -rf jco-libs
node scripts/setup.mjs
ls jco-libs
```
Expected: setup repopulates `jco-libs/` with the two JCo jars; summary shows Java 25 and `jco-proxy.jar` present.

- [ ] **Step 2: Run the unit tests**

Run: `npm test`
Expected: PASS (5 tests).

- [ ] **Step 3: Bridge startup smoke (environment-dependent)**

Full end-to-end requires SAP/VPN connectivity. At minimum confirm the bridge
gets past config + jco-libs resolution and spawns the proxy:

Run: `npm start` (Ctrl+C after the banner)
Expected (with valid `.env` + connectivity): `[bridge] jco-proxy ready …` then
`[bridge] listening on http://localhost:18080`. Without connectivity, a JCo
connect error from `[jco-proxy]` is acceptable for this step — it still proves
the jars and proxy resolved and launched. Note the outcome honestly in the PR.

- [ ] **Step 4: Confirm gitignore protects the licensed libs**

Run: `git status --porcelain jco-libs`
Expected: empty output (jco-libs/ is ignored and never staged).

---

## Self-Review

**Spec coverage:**
- JCo auto-detect from Eclipse (cross-platform) → Tasks 4, 5 ✓
- Copy into gitignored `jco-libs/` → Task 5 + `.gitignore` (Task 2 Step 4 ignores both `jco-libs/` and `jco-proxy/target/`) ✓
- Vendor jco-proxy source + prebuilt jar → Tasks 1, 2 ✓
- Rebuild docs → Task 3 ✓
- `package.json` setup script → Task 6 ✓
- `bridge.mjs` defaults → Task 7 ✓
- `.env.example` → Task 8 ✓
- README rewrite (remove vsp, JCo acquisition, provenance) → Task 9 ✓
- Testing (unit + manual + negative) → Tasks 4, 5, 10 ✓

**Gap found and fixed:** `.gitignore` must protect `jco-libs/` (licensed libs),
not just `jco-proxy/target/`. Fixed inline in Task 2 Step 4 — the `printf` now
appends both ignore lines.

**Placeholder scan:** No TBD/TODO; all code blocks complete.

**Type/name consistency:** Helper names (`getPlatformPrefix`, `jcoJarRe`,
`nativeJarRe`, `matchJcoJars`, `getEclipsePaths`, `detectJCoLibraries`) are used
identically in `scripts/setup.mjs` and the tests. `detectJCoLibraries` takes a
single options object `{ dirs, readdir, exists, prefix }` in both definition and
call site. ✓
```
