// scripts/env-file.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditEnvFile, resolveEnvFile } from './env-file.mjs';

function fixture(names) {
  const dir = mkdtempSync(join(tmpdir(), 'envfile-'));
  for (const n of names) writeFileSync(join(dir, n), 'SAP_USER=X\n');
  return dir;
}

function envFile(body) {
  const dir = mkdtempSync(join(tmpdir(), 'envaudit-'));
  const path = join(dir, '.env');
  writeFileSync(path, body);
  return path;
}

test('no argument resolves to .env', () => {
  const dir = fixture(['.env', '.env.020']);
  assert.equal(resolveEnvFile(undefined, dir), join(dir, '.env'));
  assert.equal(resolveEnvFile('', dir), join(dir, '.env'));
});

test('a bare suffix resolves to .env.<suffix>', () => {
  const dir = fixture(['.env', '.env.020']);
  assert.equal(resolveEnvFile('020', dir), join(dir, '.env.020'));
});

test('an explicit .env filename is taken as-is', () => {
  const dir = fixture(['.env', '.env.020']);
  assert.equal(resolveEnvFile('.env.020', dir), join(dir, '.env.020'));
});

test('a path argument bypasses suffix expansion', () => {
  const dir = fixture(['.env']);
  assert.equal(resolveEnvFile(join(dir, '.env'), dir), join(dir, '.env'));
});

test('a missing env file names the available ones', () => {
  const dir = fixture(['.env', '.env.020', '.env.example']);
  assert.throws(() => resolveEnvFile('030', dir), (err) => {
    assert.match(err.message, /\.env\.030/);
    assert.match(err.message, /020/);
    assert.doesNotMatch(err.message, /example/); // the template is not a target
    return true;
  });
});

test('editor swap and backup files are not offered as clients', () => {
  const dir = fixture(['.env', '.env.020', '.env.020.swp', '.env.010~', '.env.010.bak']);
  assert.throws(() => resolveEnvFile('030', dir), (err) => {
    assert.match(err.message, /available: \.env, \.env\.020$/m);
    return true;
  });
});

test('malformed arguments are rejected', () => {
  const dir = fixture(['.env']);
  for (const bad of ['../secrets', 'a/b', '..', 'x y']) {
    assert.throws(() => resolveEnvFile(bad, dir), /invalid/i, `expected reject: ${bad}`);
  }
});

// The `.env`-prefixed branch used to skip validation entirely, so an argument
// like this resolved outside the repo.
test('a .env-prefixed argument cannot smuggle in path syntax', () => {
  const dir = fixture(['.env']);
  for (const bad of ['.env/../../secrets', '.env.', '.env..', '.env./..']) {
    assert.throws(() => resolveEnvFile(bad, dir), /invalid env-file name/i, `expected reject: ${bad}`);
  }
});

test('the committed template is refused as a connection target', () => {
  const dir = fixture(['.env', '.env.example']);
  for (const arg of ['example', '.env.example']) {
    assert.throws(() => resolveEnvFile(arg, dir), /template, not a connection target/, `expected reject: ${arg}`);
  }
});

test('an editor backup is refused even when named explicitly', () => {
  const dir = fixture(['.env', '.env.020.bak', '.env.020~']);
  // `.bak` survives the name-shape check and is caught as a backup; `~` is not
  // a legal suffix character, so it is refused one step earlier. Either way the
  // bridge never connects with stale credentials.
  assert.throws(() => resolveEnvFile('.env.020.bak', dir), /editor backup/);
  assert.throws(() => resolveEnvFile('.env.020~', dir), /invalid env-file name/);
});

test('audit catches an unquoted # truncating a value', () => {
  const path = envFile('SAP_PASSWORD=abc#123\n');
  const { truncated } = auditEnvFile(path, { SAP_PASSWORD: 'abc' });
  assert.deepEqual(truncated, [{ key: 'SAP_PASSWORD', fileLength: 7, parsedLength: 3 }]);
});

test('audit accepts a quoted value containing #', () => {
  const path = envFile('SAP_PASSWORD="abc#123"\n');
  const { truncated } = auditEnvFile(path, { SAP_PASSWORD: 'abc#123' });
  assert.deepEqual(truncated, []);
});

test('audit ignores comments and values without #', () => {
  const path = envFile('# a comment\nSAP_USER=BBOCKMU\nSAP_CLIENT=020\n');
  const { truncated, shadowed } = auditEnvFile(path, { SAP_USER: 'BBOCKMU', SAP_CLIENT: '020' });
  assert.deepEqual(truncated, []);
  assert.deepEqual(shadowed, []);
});

test('audit reports a file value shadowed by the real environment', () => {
  const path = envFile('SAP_CLIENT=020\nSAP_USER=BBOCKMU\n');
  const { shadowed } = auditEnvFile(path, { SAP_CLIENT: '010', SAP_USER: 'BBOCKMU' }, new Set(['SAP_CLIENT', 'SAP_USER']));
  assert.deepEqual(shadowed, ['SAP_CLIENT']); // SAP_USER matches the file, so it is not reported
});

test('audit does not report truncation for a shadowed key', () => {
  const path = envFile('SAP_PASSWORD=abc#123\n');
  const { truncated, shadowed } = auditEnvFile(path, { SAP_PASSWORD: 'from-shell' }, new Set(['SAP_PASSWORD']));
  assert.deepEqual(truncated, []);
  assert.deepEqual(shadowed, ['SAP_PASSWORD']);
});
