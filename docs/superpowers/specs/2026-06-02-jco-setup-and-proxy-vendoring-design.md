# adt-rfc-bridge: JCo auto-setup + jco-proxy vendoring — design

Date: 2026-06-02
Status: Approved (design), pending spec review

## Problem

The public README assumes the JCo libraries and `jco-proxy.jar` are already
present, and incorrectly attributes them to `mcp-abap-adt-vsp` (a repo that is
not publicly accessible). Two distinct artifacts were conflated:

1. **SAP JCo libraries** — `com.sap.conn.jco_X.Y.Z.jar` plus a platform-native
   fragment (`com.sap.conn.jco.{macosx|win32|linux}.{arch}_X.Y.Z.jar`) that
   carries the native `libsapjco3.{dylib|so|dll}`. These are **licensed SAP
   binaries, not redistributable**. They ship inside an Eclipse ADT
   installation's `plugins/` directory (and via SAP's JCo download).
2. **`jco-proxy.jar`** — a small Java sidecar (`com.sap.mcp.proxy.RfcProxyServer`)
   that the bridge spawns. Provenance verified: originally authored by the repo
   owner (first commit 2025-11-26, absent from the public `mario-andreschak/mcp-abap-adt`
   upstream). Its `sapjco3` Maven dependency is scope `provided`, so the built
   fat-jar contains **zero** SAP JCo classes — it is the owner's own MIT code
   plus Apache-licensed libs (Javalin, Gson, slf4j) and is freely distributable.

There is no guided way to obtain the JCo libraries; a new user is stuck.

## Goal

Make a fresh clone usable with: `git clone` → `npm run setup` → edit `.env`
→ `npm start`. Model the JCo acquisition on the proven auto-detection wizard in
`mcp-abap-adt/scripts/setup/jco.ts`, adapted to the bridge's zero-dependency,
ESM-only style.

## Non-goals

- Redistributing SAP JCo libraries (never committed; always sourced from the
  user's own Eclipse ADT install).
- Downloading JCo from SAP automatically (requires an S-user; out of scope).
- Changing the bridge's runtime request/response translation logic.

## Components

### 1. Vendored `jco-proxy/` (source) + prebuilt `jco-proxy.jar`

- Copy the owner's `jco-proxy` Maven module (`src/main/java/com/sap/mcp/proxy/**`,
  `pom.xml`) into `jco-proxy/` in this repo. This is the owner's own code, so it
  is published under this repo's MIT license (© repo owner).
- Build the fat-jar **from this vendored source** (so jar ↔ source stay
  consistent) and commit it as `jco-proxy.jar` at the repo root.
- Rationale for committing the binary: end users run a JRE but should not need a
  JDK + Maven; the prebuilt jar makes `npm start` work without a build step.
- A short `jco-proxy/README.md` documents how to rebuild (`mvn -f jco-proxy/pom.xml package`),
  noting the `provided` `sapjco3` must be available to the compiler (installed
  from the user's JCo jar via `mvn install:install-file`, or supplied on the
  build classpath).

### 2. `scripts/setup.mjs` (dependency-free, ESM)

A single Node 22+ script, no npm dependencies (consistent with the bridge). Ports
the logic of `mcp-abap-adt/scripts/setup/jco.ts`:

- `getEclipsePaths()` — candidate plugin dirs, in priority order:
  `$ECLIPSE_HOME/plugins`, `~/.p2/pool/plugins`, then platform standards
  (macOS: `/Applications/Eclipse.app/...`, `~/Applications/...`, `~/eclipse/Eclipse.app/...`;
  Windows: `C:\Eclipse`, `C:\Program Files\Eclipse`, `%USERPROFILE%\Eclipse`,
  `%LOCALAPPDATA%\Eclipse`; Linux: `/opt/eclipse`, `~/eclipse`, `~/.eclipse`).
- `getPlatformPrefix()` — `darwin→macosx`, `win32→win32`, `linux→linux`.
- `detectJCoLibraries()` — first dir that contains both
  `^com\.sap\.conn\.jco_\d+\.\d+\.\d+\.jar$` and
  `^com\.sap\.conn\.jco\.<prefix>\.[a-z0-9_]+_\d+\.\d+\.\d+\.jar$`.
- Copy both jars into `./jco-libs/`. **Cross-platform native handling:** the
  platform fragment carries the native lib; JCo 3.1 self-extracts it at runtime
  when the fragment is on the classpath. The bridge already adds every
  `jco-libs/*.jar` to the classpath, so no manual `.dylib`/`.so`/`.dll`
  extraction is needed on any OS — the script just copies the correct fragment.
- `checkJava()` — confirm a `java` on PATH (warn if absent / below 21); optional
  fallback to an Eclipse-bundled JRE if found.
- Scaffold `.env` from `.env.example` if missing.
- Print a clear summary: detected Eclipse path, copied jars + architecture,
  Java version, jco-proxy.jar location, and the next step (edit `.env`, then
  `npm start`).
- Failure modes are explicit (no silent fallbacks): if no Eclipse install with
  JCo is found, print the searched paths and instruct the user to set
  `ECLIPSE_HOME` or install ADT; exit non-zero.

### 3. `package.json`

- Add script: `"setup": "node scripts/setup.mjs"`.
- Remains zero runtime dependencies.

### 4. `.gitignore`

- Add `jco-libs/` — the licensed SAP JCo libraries must never be committed.
  (`.env`, `*.log`, `node_modules/` already ignored.)

### 5. `bridge.mjs` (minimal change)

- Default `JCO_LIBS_DIR` to `<repo>/jco-libs` (was `required`), so a fresh clone
  needs only SAP host/user/password in `.env`.
- Resolve `jco-proxy.jar` from the repo root first, then fall back to
  `JCO_LIBS_DIR/jco-proxy.jar` (preserves current behavior).
- No change to request translation, header casing, CSRF emulation, or shutdown.

### 6. README rewrite

- Remove all `mcp-abap-adt-vsp` references.
- Installation: `git clone` → `npm run setup` → edit `.env` → `npm start`.
- New section "How the JCo libraries are obtained": auto-detected from the
  user's Eclipse ADT install (or SAP's JCo download); licensed and **not**
  redistributable; that is why `npm run setup` copies them from a local ADT
  rather than the repo shipping them.
- Accurate jco-proxy description: bundled in this repo (source + prebuilt jar),
  the owner's own MIT code, contains no SAP JCo bytes.
- Keep the existing "How it works", "Known limitations", ABAP MCP ecosystem
  table (already corrected to drop the broken vsp link earlier).

## Data flow (setup)

```
npm run setup
  └─ scripts/setup.mjs
       ├─ locate Eclipse ADT plugins dir (cross-platform candidates)
       ├─ match com.sap.conn.jco_*.jar + platform-native fragment
       ├─ copy both → ./jco-libs/        (gitignored)
       ├─ check java >= 21 on PATH
       ├─ ensure .env exists (copy from .env.example)
       └─ print summary + next steps
```

Runtime is unchanged: `npm start` → `bridge.mjs` spawns `java -cp <jco-libs/*.jar:jco-proxy.jar> com.sap.mcp.proxy.RfcProxyServer …`.

## Testing

- Manual: on this macOS/aarch64 machine, run `npm run setup` against the real
  Eclipse ADT install at `~/eclipse/Eclipse.app/...`; confirm both jars land in
  `jco-libs/`, `.env` is scaffolded, summary is correct, then `npm start`
  reaches the bridge `discovery` smoke test.
- Unit-ish (optional, dependency-free): a small assertion that the JCo jar
  regexes match the real bundle names (`com.sap.conn.jco_3.1.12.jar`,
  `com.sap.conn.jco.macosx.aarch64_3.1.12.jar`) and reject near-misses.
- Negative: point detection at an empty dir → script exits non-zero with the
  searched-paths message.

## Risks / notes

- Committing a ~6 MB binary (`jco-proxy.jar`) into git is accepted (decided).
- Only the maintainer rebuilds the jar; rebuild needs JDK + Maven + a `provided`
  `sapjco3` on the compile classpath — documented in `jco-proxy/README.md`.
- JCo version coupling: the proxy targets `sapjco3 3.1.12`; the copied JCo
  fragment should be a compatible 3.1.x. Setup reports the detected version so
  mismatches are visible.
