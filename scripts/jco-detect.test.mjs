// scripts/jco-detect.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getPlatformPrefix,
  jcoJarRe,
  nativeJarRe,
  matchJcoJars,
  getEclipsePaths,
  detectJCoLibraries,
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

test('getEclipsePaths puts ECLIPSE_HOME first and includes platform standards', () => {
  const darwin = getEclipsePaths({ ECLIPSE_HOME: '/opt/ecl', HOME: '/Users/x' }, 'darwin');
  assert.equal(darwin[0], '/opt/ecl/plugins');
  assert.ok(darwin.includes('/Users/x/.p2/pool/plugins'));
  assert.ok(darwin.includes('/Users/x/eclipse/Eclipse.app/Contents/Eclipse/plugins'));

  const win = getEclipsePaths(
    { USERPROFILE: 'C:\\Users\\x', LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' },
    'win32',
  );
  // path.join uses the OS separator; on POSIX hosts the tail uses '/'
  assert.ok(win.some((p) => p.startsWith('C:\\Users\\x') && (p.endsWith('Eclipse/plugins') || p.endsWith('Eclipse\\plugins'))));
  assert.ok(win.some((p) => p.includes('AppData') && (p.endsWith('Eclipse/plugins') || p.endsWith('Eclipse\\plugins'))));

  const linux = getEclipsePaths({ HOME: '/home/x' }, 'linux');
  assert.ok(linux.includes('/opt/eclipse/plugins'));
  assert.ok(linux.includes('/home/x/eclipse/plugins'));
});

test('detectJCoLibraries returns the first dir containing both jars', () => {
  const fsMap = {
    '/a': ['readme.txt'],
    '/b': ['com.sap.conn.jco_3.1.12.jar'],
    '/c': ['com.sap.conn.jco_3.1.12.jar', 'com.sap.conn.jco.macosx.aarch64_3.1.12.jar'],
  };
  const result = detectJCoLibraries({
    dirs: ['/missing', '/a', '/b', '/c'],
    readdir: (d) => fsMap[d],
    exists: (d) => d in fsMap,
    prefix: 'macosx',
  });
  assert.deepEqual(result, {
    dir: '/c',
    jcoJar: 'com.sap.conn.jco_3.1.12.jar',
    nativeJar: 'com.sap.conn.jco.macosx.aarch64_3.1.12.jar',
    architecture: 'macosx.aarch64',
  });
});

test('detectJCoLibraries returns null when no dir has both jars', () => {
  const result = detectJCoLibraries({
    dirs: ['/x'],
    readdir: () => ['com.sap.conn.jco_3.1.12.jar'],
    exists: () => true,
    prefix: 'macosx',
  });
  assert.equal(result, null);
});
