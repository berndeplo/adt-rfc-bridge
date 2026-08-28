#!/usr/bin/env node
// adt-rfc-bridge
//
// Local HTTP server that translates plain ADT REST requests into ProxyRequest
// envelopes for the bundled jco-proxy.jar, which executes them against the SAP system
// via JCo / RFC (SADT_REST_RFC_ENDPOINT). Lets HTTP-only ADT clients reach
// RFC-only SAP systems.
//
// Flow:  arc-1 → http://localhost:BRIDGE_PORT/sap/bc/adt/... → wrap as ProxyRequest
//        → POST http://localhost:<sidecar-port>/rfc-proxy → unwrap → return.

import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import {
  readdirSync, existsSync, createWriteStream, appendFileSync, readFileSync, writeFileSync, unlinkSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { auditEnvFile, resolveEnvFile } from './scripts/env-file.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_PATH = join(__dirname, '.bridge.log');
// Records which client the live bridge serves, so a second start can say so
// instead of guessing from a shared port.
const STATE_PATH = join(__dirname, '.bridge.state');

// Which SAP client to connect as is chosen by an optional argument:
//   npm start        → .env
//   npm start 020    → .env.020
// The suffix is by convention the client number; the client actually used is
// whatever SAP_CLIENT that file sets. If both files pin the same BRIDGE_PORT
// (the intended setup — nothing in the code enforces it), starting a second
// bridge hits EADDRINUSE and reports the running one instead of starting.
//
// Node's env-file loader does not overwrite variables already present in the
// real environment, so a shell export or an explicit `--env-file` wins over the
// chosen file. Precedence is per-variable, which is why an omitted variable can
// be backfilled from somewhere you didn't intend — auditEnvFile reports both
// that and the unquoted-'#' truncation below.
if (typeof process.loadEnvFile !== 'function') {
  process.stderr.write(
    `[bridge] Node ${process.version} is too old — the bridge needs Node 22+.\n` +
      '[bridge] A system node (e.g. /usr/local/bin/node) may be shadowing your nvm node; check `node -v`.\n',
  );
  process.exit(2);
}
const envArg = process.argv[2];
const shellKeys = new Set(Object.keys(process.env));
let envFile = null;
try {
  // With no argument the default `.env` is optional: an explicit
  // `node --env-file=... bridge.mjs` or a fully exported environment already
  // supplies everything, and loading `.env` underneath it would backfill the
  // variables that file deliberately omits — e.g. lending client 010's password
  // to a 020 session, which lands right back on "Name or password is incorrect".
  if (envArg !== undefined || !shellKeys.has('SAP_USER')) {
    envFile = resolveEnvFile(envArg, __dirname);
    process.loadEnvFile(envFile);
  }
} catch (err) {
  // Prefix every line — the not-found message carries an `available: ...` line.
  process.stderr.write(String(err.message).split('\n').map((l) => `[bridge] ${l}\n`).join(''));
  process.exit(2);
}

if (envFile) {
  const { truncated, shadowed } = auditEnvFile(envFile, process.env, shellKeys);
  if (truncated.length) {
    for (const { key, fileLength, parsedLength } of truncated) {
      process.stderr.write(
        `[bridge] ${key} in ${envFile} is unquoted and contains '#', so Node's env-file parser\n`
        + `[bridge] kept only ${parsedLength} of ${fileLength} characters. SAP would report that as\n`
        + `[bridge] "Name or password is incorrect (repeat logon)". Quote it: ${key}="..."\n`,
      );
    }
    process.exit(2);
  }
  if (shadowed.length) {
    process.stderr.write(
      `[bridge] WARNING: your shell environment overrides ${shadowed.join(', ')} from\n`
      + `[bridge] ${envFile}. Run \`unset ${shadowed.join(' ')}\` to use the file's values.\n`,
    );
    // Connecting as the wrong client is the worst version of this: the ABAP
    // repository is cross-client, so nothing in the source would look wrong.
    if (envArg !== undefined && shadowed.includes('SAP_CLIENT')) {
      process.stderr.write(
        `[bridge] Refusing to start: you asked for '${envArg}' but SAP_CLIENT is pinned by the shell.\n`,
      );
      process.exit(2);
    }
  }
}

// ANSI yellow + bold.
const YELLOW = '\x1b[33;1m';
const RESET = '\x1b[0m';

// Canonical header casing expected by jco-proxy (which reads some headers
// case-sensitively). Keyed by the lower-cased name Node hands us. Matches the
// casing VSP's Go client sends. `X-sap-adt-sessiontype` is the load-bearing one
// (stateful session / lock survival); the rest are restored defensively to
// mirror VSP exactly.
const CANONICAL_HEADER = {
  'x-sap-adt-sessiontype': 'X-sap-adt-sessiontype',
  'x-csrf-token': 'X-CSRF-Token',
  cookie: 'Cookie',
  accept: 'Accept',
  'content-type': 'Content-Type',
};

// The jco-proxy / RFC backend has no CSRF concept: it rejects HEAD (used by ADT
// clients to fetch a token) with 400, and never returns an X-CSRF-Token header.
// Real SAP ICF answers `X-CSRF-Token: fetch` with a token that the client then
// echoes back on writes. We emulate that handshake here so stock HTTP ADT
// clients (arc-1, Eclipse, abap-adt-api, ...) work unmodified: a synthesized
// token is handed out on fetch requests and ignored on the way back in (the RFC
// backend doesn't validate it). The token is per-process; clients only echo it.
const SYNTH_CSRF_TOKEN = randomBytes(16).toString('hex').toUpperCase();

function getenv(key, fallback) {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
}

function required(key) {
  const v = process.env[key];
  if (v === undefined) {
    process.stderr.write(`[bridge] missing required env var: ${key}\n`);
    process.exit(2);
  }
  // Present but empty is a different diagnosis: the line is right there in the
  // file, so "missing" would send the reader looking for the wrong thing.
  if (v === '') {
    process.stderr.write(
      `[bridge] ${key} is set but parsed as empty — a leading unquoted '#' starts a comment. `
      + `Quote it: ${key}="..."\n`,
    );
    process.exit(2);
  }
  return v;
}

// Tee-style logger: writes to stderr (live terminal) AND .bridge.log (for tailing
// from a second instance). The log stream is opened lazily so the "another
// instance already running" path doesn't truncate the existing log file.
let logStream = null;
function getLogStream() {
  if (!logStream) logStream = createWriteStream(LOG_PATH, { flags: 'a' });
  return logStream;
}
// Local-time timestamp, e.g. "2026-06-23 16:06:08.123" — matches the shell's
// local clock rather than UTC so it lines up with what the user sees.
function ts() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}
function log(msg) {
  const line = `${ts()} ${msg.endsWith('\n') ? msg : `${msg}\n`}`;
  process.stderr.write(line);
  getLogStream().write(line);
}
// process.exit() does not drain a pending WriteStream — of several writes queued
// in the same tick only the first reaches the file — so the shutdown paths, which
// carry the reason the bridge died, write to the log synchronously instead.
function logSync(msg) {
  const line = `${ts()} ${msg.endsWith('\n') ? msg : `${msg}\n`}`;
  process.stderr.write(line);
  try {
    appendFileSync(LOG_PATH, line);
  } catch {}
}
// Child (jco-proxy) output arrives in arbitrary chunks; buffer and emit one
// timestamped line at a time so the stamp lands at each line start. Keyed per
// stream rather than per prefix: stdout and stderr share a display prefix, and a
// single buffer would let a partial stdout line be completed by the next stderr
// chunk, splicing two unrelated lines together.
const chunkBuffers = new Map();
function logChunk(stream, prefix, chunk) {
  const entry = chunkBuffers.get(stream) || { prefix, rest: '' };
  const lines = (entry.rest + chunk).split('\n');
  chunkBuffers.set(stream, { prefix, rest: lines.pop() }); // retain trailing partial line
  for (const line of lines) {
    const out = `${ts()} ${prefix}${line}\n`;
    process.stderr.write(out);
    getLogStream().write(out);
  }
}
// Release buffered partial lines (a final line with no trailing newline — often
// the message explaining why the child stopped). Called from every exit path,
// and written synchronously for the same reason logSync exists.
function flushChunks() {
  for (const [, { prefix, rest }] of chunkBuffers) {
    if (rest) {
      const out = `${ts()} ${prefix}${rest}\n`;
      process.stderr.write(out);
      try {
        appendFileSync(LOG_PATH, out);
      } catch {}
    }
  }
  chunkBuffers.clear();
}

function readState() {
  try {
    return JSON.parse(readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return null; // absent, unreadable or malformed all mean "can't identify"
  }
}
function pidAlive(pid) {
  try {
    process.kill(pid, 0); // signal 0 tests for existence without delivering one
    return true;
  } catch {
    return false;
  }
}
function unlinkState() {
  try {
    unlinkSync(STATE_PATH);
  } catch {}
}

// If the port is already taken, work out *what* holds it before reacting: a
// bridge on the same client is worth tailing, a bridge on a different client
// means the requested switch cannot happen, and an unidentified process means
// we should not pretend to know. Returns when the port is free.
async function ensureNotAlreadyRunning(port, wantClient) {
  const inUse = await new Promise((resolve) => {
    const probe = http.createServer();
    probe.once('error', (err) => {
      resolve(err.code === 'EADDRINUSE');
    });
    probe.listen(port, '127.0.0.1', () => {
      probe.close(() => resolve(false));
    });
  });
  if (!inUse) {
    // Drop a state file left behind by a bridge that died without cleaning up,
    // so the next start doesn't report a dead pid as the current owner.
    const stale = readState();
    if (stale && !pidAlive(stale.pid)) unlinkState();
    return;
  }

  const state = readState();
  const live = state && state.port === port && pidAlive(state.pid);

  // The switch case: the two env files share a port, so serving a different
  // client means stopping the other bridge. Failing loudly here matters because
  // the ABAP repository is cross-client — working in the wrong client looks
  // completely normal in the source.
  if (live && state.client !== wantClient) {
    const where = state.envFile ? `, ${state.envFile}` : '';
    for (const ln of [
      '',
      `  Port ${port} is already serving SAP client ${state.client} (pid ${state.pid}${where}).`,
      `  You asked for client ${wantClient}; both env files use port ${port}.`,
      `  Stop the running bridge first:  kill ${state.pid}`,
      '',
    ]) process.stderr.write(`${YELLOW}${ln}${RESET}\n`);
    process.exit(1);
  }

  if (!live && !existsSync(LOG_PATH)) {
    process.stderr.write(
      `${YELLOW}Port ${port} is held by another process and there is no bridge state file `
      + `or log to identify it. Exiting.${RESET}\n`,
    );
    process.exit(1);
  }

  const banner = [
    '',
    '================================================================',
    `  adt-rfc-bridge is ALREADY RUNNING on port ${port}`,
    live
      ? `  Serving client ${state.client} (pid ${state.pid}) — the client you asked for.`
      : '  Cannot identify the holder (no state file — it may predate this version),',
    live ? '' : '  so the log below may not be current.',
    '',
    "  Tailing the running bridge's log below.",
    '  Press Ctrl+C to detach (the bridge keeps running).',
    '================================================================',
    '',
  ].filter((ln, i, all) => !(ln === '' && all[i - 1] === ''));
  for (const ln of banner) process.stderr.write(`${YELLOW}${ln}${RESET}\n`);

  // -F follows the file by name across truncation/rotation; -n 40 prints recent context first.
  const tail = spawn('tail', ['-n', '40', '-F', LOG_PATH], { stdio: 'inherit' });
  const detach = (sig) => {
    try { tail.kill('SIGTERM'); } catch {}
    process.exit(0); // detaching from the tail is a deliberate no-op, not a failure
  };
  tail.on('exit', () => process.exit(0));
  process.on('SIGINT', () => detach('SIGINT'));
  process.on('SIGTERM', () => detach('SIGTERM'));
  // Block forever — process exits via the tail child.
  await new Promise(() => {});
}

const rawPort = getenv('BRIDGE_PORT', '18080');
const bridgePort = Number(rawPort);
if (!Number.isInteger(bridgePort) || bridgePort <= 0 || bridgePort > 65535) {
  process.stderr.write(
    `[bridge] BRIDGE_PORT is not a valid port: '${rawPort}'${envFile ? ` (from ${envFile})` : ''}\n`,
  );
  process.exit(2);
}

// Built before the already-running check so a broken env file is reported first,
// and so the check can name the client we were actually asked for.
const cfg = {
  bridgePort,
  java: getenv('JAVA', 'java'),
  jcoLibsDir: getenv('JCO_LIBS_DIR', join(__dirname, 'jco-libs')),
  asHost: process.env.SAP_ASHOST,
  sysNr: process.env.SAP_SYSNR,
  msHost: process.env.SAP_MSHOST,
  msServ: process.env.SAP_MSSERV,
  r3Name: process.env.SAP_R3NAME,
  group: process.env.SAP_GROUP,
  client: required('SAP_CLIENT'),
  user: required('SAP_USER'),
  password: required('SAP_PASSWORD'),
  language: getenv('SAP_LANGUAGE', 'EN'),
};

await ensureNotAlreadyRunning(bridgePort, cfg.client);

if (!existsSync(cfg.jcoLibsDir)) {
  log(`[bridge] JCO_LIBS_DIR does not exist: ${cfg.jcoLibsDir}`);
  log(`[bridge] Run \`npm run setup\` to copy the SAP JCo libraries from your Eclipse ADT install.`);
  process.exit(2);
}

const proxyJarCandidates = [
  join(__dirname, 'jco-proxy.jar'),
  join(cfg.jcoLibsDir, 'jco-proxy.jar'),
];
const proxyJar = proxyJarCandidates.find((p) => existsSync(p));
if (!proxyJar) {
  log(`[bridge] jco-proxy.jar not found (looked in: ${proxyJarCandidates.join(', ')})`);
  process.exit(2);
}

const classpath = [
  proxyJar,
  ...readdirSync(cfg.jcoLibsDir)
    .filter((f) => f.endsWith('.jar') && f !== 'jco-proxy.jar')
    .map((f) => join(cfg.jcoLibsDir, f)),
].join(':');

const args = [
  '-cp',
  classpath,
  `-Djava.library.path=${cfg.jcoLibsDir}`,
  '--enable-native-access=ALL-UNNAMED',
  'com.sap.mcp.proxy.RfcProxyServer',
];

const push = (flag, val) => {
  if (val) args.push(flag, val);
};
push('--ashost', cfg.asHost);
push('--sysnr', cfg.sysNr);
push('--mshost', cfg.msHost);
push('--msserv', cfg.msServ);
push('--r3name', cfg.r3Name);
push('--group', cfg.group);
push('--client', cfg.client);
push('--user', cfg.user);
push('--password', cfg.password);
push('--lang', cfg.language); // ConnectionConfig parses --lang, not --language

// If a previous bridge died via SIGKILL its jco-proxy child can be orphaned
// and still hold its Jetty port. Reap any orphan before launching a new one.
const orphans = spawnSync('pgrep', ['-f', 'com.sap.mcp.proxy.RfcProxyServer'], { encoding: 'utf8' });
const orphanPids = (orphans.stdout || '')
  .split('\n')
  .map((s) => s.trim())
  .filter(Boolean)
  .filter((pid) => pid !== String(process.pid));
for (const pid of orphanPids) {
  log(`[bridge] reaping orphan jco-proxy PID ${pid}`);
  try { process.kill(Number(pid), 'SIGKILL'); } catch {}
}

// Substitute rather than drop: filtering the element out left the log reading
// `--password --lang EN`, as if --lang were the password's value.
const logArgs = args.map((a) => (a === cfg.password ? '***' : a));
log(`[bridge] starting jco-proxy: ${cfg.java} ${logArgs.join(' ')}`);

const child = spawn(cfg.java, args, {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    LD_LIBRARY_PATH: cfg.jcoLibsDir,
    DYLD_LIBRARY_PATH: cfg.jcoLibsDir,
  },
});

// Without an 'error' listener a failed spawn throws as an uncaught exception,
// and Node's error object carries `spawnargs` — so the whole argv, password
// included, would land on the terminal and in the log. 'exit' never fires in
// that case either, leaving the reject path and the 30s timeout unreachable.
child.on('error', (err) => {
  logSync(
    `[bridge] cannot start java (${cfg.java}): ${err.code || err.message} — `
    + 'check JAVA in your env file, or install a JRE 21+ on PATH',
  );
  process.exit(2);
});

child.stderr.on('data', (chunk) => logChunk('err', '[jco-proxy] ', chunk));

let sidecarPort = null;
const portReady = new Promise((resolve, reject) => {
  let buf = '';
  child.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    if (!sidecarPort) {
      buf += text;
      const m = buf.match(/SIDECAR_PORT=(\d+)/);
      if (m) {
        sidecarPort = Number(m[1]);
        log(`[bridge] jco-proxy ready on http://localhost:${sidecarPort}`);
        resolve(sidecarPort);
        return;
      }
    } else {
      logChunk('out', '[jco-proxy] ', chunk);
    }
  });
  child.on('exit', (code, signal) => {
    flushChunks();
    if (!sidecarPort) {
      // Until the port is announced every stdout chunk goes into `buf` for the
      // regex and is never logged — so on the commonest failure of all (the
      // proxy dying at startup) the diagnostic would otherwise be discarded.
      if (buf.trim()) logSync(`[jco-proxy] ${buf.trim()}`);
      reject(new Error(`jco-proxy exited (code=${code} signal=${signal}) before announcing port`));
    } else {
      logSync(`[bridge] jco-proxy exited (code=${code} signal=${signal})`);
      if (readState()?.pid === process.pid) unlinkState();
      process.exit(code ?? 1);
    }
  });
  setTimeout(() => {
    if (!sidecarPort) reject(new Error('timeout waiting 30s for jco-proxy to start'));
  }, 30_000);
});

try {
  await portReady;
} catch (err) {
  log(`[bridge] ${err.message}`);
  child.kill('SIGKILL');
  process.exit(1);
}

const server = http.createServer(async (req, res) => {
  const t0 = Date.now();
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const bodyText = Buffer.concat(chunks).toString('utf8');

    // Build headers map. Strip hop-by-hop + host (jco-proxy controls its own Host).
    //
    // Node's HTTP server lower-cases every incoming header name. jco-proxy reads
    // some headers CASE-SENSITIVELY — most importantly `X-sap-adt-sessiontype`,
    // which it only recognizes in that exact casing. A lower-cased
    // `x-sap-adt-sessiontype` is read as null, so the proxy treats every request
    // as stateless, never opens a stateful JCo context, never issues
    // `sap-contextid`, and the enqueue lock from LOCK is gone by the time the
    // source PUT arrives (→ HTTP 423 "not locked"). VSP's Go client avoids this
    // because Go preserves header casing. So we restore the canonical casing the
    // proxy expects for the headers it cares about; unknown headers pass through
    // as-is.
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const lk = k.toLowerCase();
      if (lk === 'host' || lk === 'connection' || lk === 'content-length' || lk === 'transfer-encoding') continue;
      const name = CANONICAL_HEADER[lk] || k;
      headers[name] = Array.isArray(v) ? v.join(', ') : String(v);
    }

    // The RFC backend has no HEAD verb (the proxy 400s on it). ADT clients use
    // HEAD only to fetch a CSRF token / probe a resource, so forward it upstream
    // as GET and return headers without a body — the HTTP-level emulation of HEAD.
    const isHead = req.method === 'HEAD';
    const csrfFetch = String(req.headers['x-csrf-token'] || '').toLowerCase() === 'fetch';

    const proxyReq = {
      method: isHead ? 'GET' : req.method,
      uri: req.url,
      headers,
      body: bodyText || undefined,
    };

    const upstream = await fetch(`http://127.0.0.1:${sidecarPort}/rfc-proxy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(proxyReq),
    });

    if (!upstream.ok) {
      const text = await upstream.text();
      log(`[bridge] jco-proxy returned ${upstream.status}: ${text.slice(0, 200)}`);
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end(`jco-proxy bridge error: HTTP ${upstream.status}\n${text}`);
      return;
    }

    const proxyResp = await upstream.json();
    const respHeaders = {};
    for (const [k, v] of Object.entries(proxyResp.headers || {})) {
      respHeaders[k] = String(v);
    }

    // Emulate the SAP CSRF handshake: when a client asked for a token and the
    // RFC backend (which has none) didn't supply one, hand out a synthesized one.
    if (csrfFetch && !respHeaders['X-CSRF-Token'] && !respHeaders['x-csrf-token']) {
      respHeaders['X-CSRF-Token'] = SYNTH_CSRF_TOKEN;
    }

    const statusCode = proxyResp.statusCode || 500;
    // Node rejects a statusMessage containing anything outside \t and
    // \x20-\x7e\x80-\xff with ERR_INVALID_CHAR. JCo errors arrive multi-line —
    // the case we hit in practice — and can also carry non-Latin-1 text once the
    // logon language isn't EN/DE, so filter to exactly what Node accepts. The
    // replace must precede the slice: cutting at 512 can bisect a surrogate pair
    // and reintroduce the throw. 512 is an arbitrary cap to keep headers sane.
    const statusText = (proxyResp.reasonPhrase || '')
      .replace(/[^\t\x20-\x7e\x80-\xff]/g, ' ')
      .slice(0, 512);
    res.writeHead(statusCode, statusText, respHeaders);
    // HEAD responses carry headers only, no body.
    res.end(isHead ? undefined : proxyResp.body || '');
    log(`[bridge] ${req.method} ${req.url} → ${statusCode} ${statusText} (${Date.now() - t0}ms)`);
  } catch (err) {
    log(`[bridge] handler error: ${err?.stack || err}`);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`bridge error: ${err?.message || err}`);
    } else {
      try {
        res.end();
      } catch {}
    }
  }
});

// The probe in ensureNotAlreadyRunning only treats EADDRINUSE as "taken", so a
// port we cannot bind for another reason (EACCES below 1024) gets this far —
// with jco-proxy already spawned, which would be orphaned by an unhandled throw.
server.on('error', (err) => {
  logSync(
    `[bridge] cannot listen on ${cfg.bridgePort}: ${err.code || err.message}`
    + (err.code === 'EACCES' ? ' — ports below 1024 need root; pick a higher BRIDGE_PORT' : ''),
  );
  try {
    child.kill('SIGKILL');
  } catch {}
  process.exit(2);
});

server.listen(cfg.bridgePort, '127.0.0.1', () => {
  log(`[bridge] listening on http://localhost:${cfg.bridgePort}`);
  log(`[bridge] arc-1 connection: SAP_URL=http://localhost:${cfg.bridgePort} SAP_CLIENT=${cfg.client} SAP_USER=${cfg.user}`);
  try {
    writeFileSync(
      STATE_PATH,
      `${JSON.stringify({ pid: process.pid, port: cfg.bridgePort, client: cfg.client, envFile })}\n`,
    );
  } catch {}
});

let shuttingDown = false;
function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  logSync(`[bridge] received ${sig}, shutting down`);
  // A child that ignores SIGINT is SIGKILLed below and its 'exit' handler never
  // runs, so flush here too or its last partial line dies with it.
  flushChunks();
  if (readState()?.pid === process.pid) unlinkState();
  try {
    server.close();
  } catch {}
  try {
    child.kill('SIGINT');
  } catch {}
  setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {}
    process.exit(0);
  }, 5_000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
