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

// Filename of the native JCo shared library that must sit on java.library.path.
// It ships *inside* the platform fragment jar (e.g. lib/libsapjco3.dylib) and
// has to be extracted as a loose file for the JVM's native loader to find it.
export function getNativeLibName(platform = process.platform) {
  switch (platform) {
    case 'darwin': return 'libsapjco3.dylib';
    case 'linux': return 'libsapjco3.so';
    case 'win32': return 'sapjco3.dll';
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
