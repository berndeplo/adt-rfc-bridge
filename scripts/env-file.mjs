// scripts/env-file.mjs
//
// Resolves which env file the bridge should load, so one checkout can serve
// several SAP clients, and audits the loaded file for the two ways it can lie
// about what the bridge will actually connect as.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';

// Accepted argument shapes: a bare suffix must start alphanumeric and stay
// within [A-Za-z0-9._-], and an explicit name must look exactly like `.env` or
// `.env.<suffix>`. Neither admits path syntax, so a typo'd `npm start ../foo`
// fails loudly instead of resolving somewhere surprising. An absolute path is
// passed through by design: this is input hygiene for a local dev tool, not a
// traversal guard, and there is no privilege boundary here to defend.
const SUFFIX_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ENV_NAME_RE = /^\.env(\.[A-Za-z0-9][A-Za-z0-9._-]*)?$/;

// Files that exist in a checkout but must never be connected with: the
// committed template (placeholder credentials), and editor backups/swap files
// (whatever was in the file *before* the edit — e.g. a rotated-away password).
const TEMPLATE_NAME = '.env.example';
const EDITOR_DROPPING_RE = /(?:\.sw[a-p]|~|\.bak|\.orig|\.tmp)$/;

// resolveEnvFile(arg, dir) → absolute path of an existing, connectable env file.
// `arg` is a bare suffix ('020'), an explicit '.env'/'.env.*' name, an absolute
// path, or undefined/'' for the default `.env`. Throws when the argument is
// malformed, names a non-target, or the file is absent; bridge.mjs turns that
// into a `[bridge] ...` message and exit 2.
export function resolveEnvFile(arg, dir) {
  let path;
  if (arg === undefined || arg === '') {
    path = join(dir, '.env');
  } else if (arg.startsWith('.env')) {
    if (!ENV_NAME_RE.test(arg)) {
      throw new Error(`invalid env-file name '${arg}' — expected '.env' or '.env.<suffix>'`);
    }
    path = join(dir, arg);
  } else if (isAbsolute(arg)) {
    path = arg;
  } else if (SUFFIX_RE.test(arg)) {
    path = join(dir, `.env.${arg}`);
  } else {
    throw new Error(
      `invalid env-file argument '${arg}' — pass a client suffix like '020', a '.env.*' filename, or an absolute path`,
    );
  }

  const name = basename(path);
  if (name === TEMPLATE_NAME) {
    throw new Error(
      `${TEMPLATE_NAME} is a template, not a connection target — copy it to .env and fill in your credentials`,
    );
  }
  if (EDITOR_DROPPING_RE.test(name)) {
    throw new Error(`'${name}' is an editor backup, not a connection target — it may hold stale credentials`);
  }
  if (!existsSync(path)) {
    throw new Error(`env file not found: ${path}\n${availableHint(dir)}`);
  }
  return path;
}

// Two silent ways the loaded file misrepresents the connection:
//
//  - truncation: Node's env-file parser treats an unquoted `#` as the start of a
//    comment, so `SAP_PASSWORD=abc#123` becomes `abc`. Nothing downstream can
//    tell; the only symptom is SAP answering "Name or password is incorrect
//    (repeat logon)", which sends you hunting in entirely the wrong place.
//  - shadowing: the loader never overwrites a variable already in the real
//    environment, so a leftover `export SAP_CLIENT=010` beats the file. Because
//    the ABAP repository is cross-client, source looks identical in the wrong
//    client and there is no cue you are in it.
//
// Reports key names and lengths only — never a value.
export function auditEnvFile(path, env = process.env, shellKeys = new Set()) {
  const truncated = [];
  const shadowed = [];
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    const rhs = line.slice(eq + 1);
    const quoted = /^(["']).*\1$/.test(rhs);
    // An opening quote with no closing one on this line means a multi-line
    // value; the line-at-a-time read above can't judge it, so leave it alone.
    if (!quoted && /^["']/.test(rhs)) continue;
    const fileValue = quoted ? rhs.slice(1, -1) : rhs.trim();
    const parsed = env[key];
    if (typeof parsed !== 'string') continue;

    if (shellKeys.has(key)) {
      if (parsed !== fileValue) shadowed.push(key);
      continue;
    }
    if (!quoted && rhs.includes('#') && parsed.length < fileValue.length) {
      truncated.push({ key, fileLength: fileValue.length, parsedLength: parsed.length });
    }
  }
  return { truncated, shadowed };
}

function availableHint(dir) {
  let found;
  try {
    found = readdirSync(dir)
      .filter((f) => f === '.env' || f.startsWith('.env.'))
      .filter((f) => f !== TEMPLATE_NAME && !EDITOR_DROPPING_RE.test(f))
      .sort();
  } catch (err) {
    // A best-effort hint must never mask the real "not found" error, but it
    // must not invent a reassuring answer either: claiming "no env files here"
    // when the directory is merely unreadable sends the user to `npm run setup`,
    // which will fail the same way.
    return `could not list env files in ${dir}: ${err.code}`;
  }
  return found.length
    ? `available: ${found.join(', ')}`
    : 'no env files here yet — run `npm run setup` to create .env from .env.example';
}
