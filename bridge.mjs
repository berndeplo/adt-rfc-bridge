#!/usr/bin/env node
// adt-rfc-bridge
//
// Local HTTP server that translates plain ADT REST requests into ProxyRequest
// envelopes for vsp's jco-proxy.jar, which executes them against the SAP system
// via JCo / RFC (SADT_REST_RFC_ENDPOINT). Lets HTTP-only ADT clients reach
// RFC-only SAP systems.
//
// Flow:  arc-1 → http://localhost:BRIDGE_PORT/sap/bc/adt/... → wrap as ProxyRequest
//        → POST http://localhost:<sidecar-port>/rfc-proxy → unwrap → return.

import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { readdirSync, existsSync, createWriteStream } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_PATH = join(__dirname, '.bridge.log');

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
  if (!v) {
    process.stderr.write(`[bridge] missing required env var: ${key}\n`);
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
function log(msg) {
  const line = msg.endsWith('\n') ? msg : `${msg}\n`;
  process.stderr.write(line);
  getLogStream().write(line);
}
function logChunk(prefix, chunk) {
  const text = `${prefix}${chunk}`;
  process.stderr.write(text);
  getLogStream().write(text);
}

// If port is already taken by another bridge, print a yellow banner and
// tail the running bridge's log instead of crashing. Resolves when the port
// is free (= we can proceed with normal startup).
async function ensureNotAlreadyRunning(port) {
  const inUse = await new Promise((resolve) => {
    const probe = http.createServer();
    probe.once('error', (err) => {
      resolve(err.code === 'EADDRINUSE');
    });
    probe.listen(port, '127.0.0.1', () => {
      probe.close(() => resolve(false));
    });
  });
  if (!inUse) return;

  const banner = [
    '',
    '================================================================',
    `  adt-rfc-bridge is ALREADY RUNNING on port ${port}`,
    '',
    "  Tailing the running bridge's log below.",
    '  Press Ctrl+C to detach (the bridge keeps running).',
    '================================================================',
    '',
  ];
  for (const ln of banner) process.stderr.write(`${YELLOW}${ln}${RESET}\n`);

  if (!existsSync(LOG_PATH)) {
    process.stderr.write(
      `${YELLOW}No log file at ${LOG_PATH} — port ${port} is held by something else. Exiting.${RESET}\n`,
    );
    process.exit(1);
  }

  // -F follows the file by name across truncation/rotation; -n 40 prints recent context first.
  const tail = spawn('tail', ['-n', '40', '-F', LOG_PATH], { stdio: 'inherit' });
  const detach = (sig) => {
    try { tail.kill('SIGTERM'); } catch {}
    process.exit(sig === 'SIGTERM' ? 0 : 0);
  };
  tail.on('exit', () => process.exit(0));
  process.on('SIGINT', () => detach('SIGINT'));
  process.on('SIGTERM', () => detach('SIGTERM'));
  // Block forever — process exits via the tail child.
  await new Promise(() => {});
}

const bridgePort = Number(getenv('BRIDGE_PORT', '18080'));
await ensureNotAlreadyRunning(bridgePort);

const cfg = {
  bridgePort,
  java: getenv('JAVA', 'java'),
  jcoLibsDir: required('JCO_LIBS_DIR'),
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

if (!existsSync(cfg.jcoLibsDir)) {
  log(`[bridge] JCO_LIBS_DIR does not exist: ${cfg.jcoLibsDir}`);
  process.exit(2);
}

const proxyJar = join(cfg.jcoLibsDir, 'jco-proxy.jar');
if (!existsSync(proxyJar)) {
  log(`[bridge] jco-proxy.jar not found at: ${proxyJar}`);
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
push('--language', cfg.language);

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

log(`[bridge] starting jco-proxy: ${cfg.java} ${args.filter((a) => a !== cfg.password).join(' ')}`);

const child = spawn(cfg.java, args, {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    LD_LIBRARY_PATH: cfg.jcoLibsDir,
    DYLD_LIBRARY_PATH: cfg.jcoLibsDir,
  },
});

child.stderr.on('data', (chunk) => logChunk('[jco-proxy] ', chunk));

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
      logChunk('[jco-proxy] ', chunk);
    }
  });
  child.on('exit', (code, signal) => {
    if (!sidecarPort) reject(new Error(`jco-proxy exited (code=${code} signal=${signal}) before announcing port`));
    else {
      log(`[bridge] jco-proxy exited (code=${code} signal=${signal})`);
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
    const statusText = proxyResp.reasonPhrase || '';
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

server.listen(cfg.bridgePort, '127.0.0.1', () => {
  log(`[bridge] listening on http://localhost:${cfg.bridgePort}`);
  log(`[bridge] arc-1 connection: SAP_URL=http://localhost:${cfg.bridgePort} SAP_CLIENT=${cfg.client} SAP_USER=${cfg.user}`);
});

let shuttingDown = false;
function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`[bridge] received ${sig}, shutting down`);
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
