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
