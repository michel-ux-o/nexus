import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = '.work/release186-manifest.json';
const sourceDirectories = ['src', 'server', 'public', 'android/app/src'];
const configurationFiles = [
  'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts',
  'index.html', 'render.yaml', 'Dockerfile', '.dockerignore',
  'scripts/build-sync-validator.mjs',
  'android/settings.gradle', 'android/build.gradle', 'android/gradle.properties',
  'android/app/build.gradle', 'scripts/android-toolchain.ps1', 'scripts/release186-manifest.mjs', 'docs/android-wecker.md',
];
const sourceExtensions = /\.(?:java|[cm]?js|jsx|ts|tsx|css|scss|html|json|md|txt|xml|webmanifest|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf)$/i;
const excludedDirectories = new Set([
  'node_modules', 'dist', 'build', 'coverage', 'test', 'tests', '__tests__',
  '__snapshots__', 'artifacts', 'backups', 'logs', 'tmp', 'temp',
  'test-results', 'playwright-report', 'userdata', 'user-data',
]);
// This is application source, despite sharing a name with generated test output.
const sourceArtifactDirectories = new Set(['src/menu/artifacts']);
export const RELEASE_LIMITS = Object.freeze({
  maxSourceFileBytes: 8 * 1024 * 1024,
  maxApkBytes: 64 * 1024 * 1024,
  maxTotalBytes: 96 * 1024 * 1024,
  maxFiles: 5000,
});

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function portablePath(path) { return path.split(sep).join('/'); }
function inside(root, path) {
  const local = relative(root, path);
  return local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local);
}
function excludedPath(path) {
  const parts = path.split('/');
  const filename = parts.at(-1);
  if (parts.some((part, index) => part.startsWith('.') || (excludedDirectories.has(part.toLowerCase()) && !sourceArtifactDirectories.has(parts.slice(0, index + 1).join('/'))))) return 'local-or-hidden-path';
  if (/^(?:credentials?|secrets?|keystore|local\.properties)(?:[.-]|$)/i.test(filename)) return 'credential-filename';
  if (/\.(?:pem|key|p12|pfx|jks|keystore|env|log|bak|tmp|sqlite3?|db|map|zip|aab|apk)$/i.test(filename)) return 'local-or-sensitive-file';
  if (/\.(?:test|spec)\.[^.]+$/i.test(filename)) return 'test-source';
  return null;
}

// Findings deliberately contain locations and rule names, never matching text.
export function scanSecrets(path, bytes) {
  const text = bytes.toString('utf8');
  const rules = [
    ['private-key', /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g],
    ['provider-token', /\b(?:sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}|sb_secret_[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,}|rnd_[A-Za-z0-9_-]{20,}|re_[A-Za-z0-9]{24,}|AKIA[A-Z0-9]{16})\b/g],
    ['jwt-literal', /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/g],
    ['credential-in-url', /\b(?:https?|postgres(?:ql)?):\/\/[^\s\/@:'"<>]+:[^\s\/@'"<>]+@/gi],
    ['credential-literal', /(?<![\w$-])(?:[A-Z_]*(?:API_KEY|SERVICE_ROLE_KEY|SETUP_CODE|ACCESS_TOKEN|SECRET_KEY|PASSWORD)|apiKey|serviceRoleKey|accessToken|secretKey|password)\b['"]?\s*[=:]\s*['"]([^'"\r\n]{12,})['"]/g],
  ];
  const findings = [];
  for (const [rule, pattern] of rules) {
    for (const match of text.matchAll(pattern)) {
      if (rule === 'credential-literal' && /^(?:your[-_ ]|replace[-_ ]|example|placeholder|test[-_ ]|changeme|<|\$\{)/i.test(match[1])) continue;
      findings.push({ path, line: text.slice(0, match.index).split('\n').length, rule });
    }
  }
  return findings;
}

export async function createReleaseManifest({ root = projectRoot, apk = null } = {}) {
  root = resolve(root);
  const files = [];
  const excluded = [];
  const findings = [];
  const errors = [];
  let totalBytes = 0;
  let candidateCount = 0;
  const addError = (path, rule) => errors.push({ path, rule });

  async function addFile(path, isApk = false) {
    candidateCount += 1;
    if (candidateCount > RELEASE_LIMITS.maxFiles) {
      if (candidateCount === RELEASE_LIMITS.maxFiles + 1) addError(path, 'file-count-limit');
      return;
    }
    const absolutePath = resolve(root, path);
    if (!inside(root, absolutePath)) { addError(path, 'outside-project'); return; }
    // Also protect the explicit APK path, which bypasses directory traversal.
    const parents = path.split('/').slice(0, -1);
    for (let index = 1; index <= parents.length; index += 1) {
      const parent = parents.slice(0, index).join('/');
      let parentInfo;
      try { parentInfo = await lstat(resolve(root, parent)); } catch { addError(parent, 'missing-or-unreadable-directory'); return; }
      if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) { addError(parent, 'real-directory-required'); return; }
    }
    let info;
    try { info = await lstat(absolutePath); } catch { addError(path, 'missing-or-unreadable-file'); return; }
    if (!info.isFile() || info.isSymbolicLink()) { addError(path, 'regular-file-required'); return; }
    const limit = isApk ? RELEASE_LIMITS.maxApkBytes : RELEASE_LIMITS.maxSourceFileBytes;
    if (info.size > limit || (isApk && info.size < 4)) { addError(path, 'file-size-limit'); return; }
    totalBytes += info.size;
    if (totalBytes > RELEASE_LIMITS.maxTotalBytes) { addError(path, 'total-size-limit'); return; }
    let bytes;
    try { bytes = await readFile(absolutePath); } catch { addError(path, 'unreadable-file'); return; }
    let after;
    try { after = await lstat(absolutePath); } catch { addError(path, 'file-changed-during-read'); return; }
    if (!after.isFile() || after.isSymbolicLink() || bytes.length !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ino !== info.ino) {
      addError(path, 'file-changed-during-read'); return;
    }
    if (isApk) {
      if (bytes.readUInt32LE(0) !== 0x04034b50) { addError(path, 'apk-zip-header-required'); return; }
    } else {
      findings.push(...scanSecrets(path, bytes));
    }
    files.push({ path, bytes: bytes.length, sha256: sha256(bytes) });
  }

  async function walk(directory) {
    const absolutePath = resolve(root, directory);
    let info;
    try { info = await lstat(absolutePath); } catch { addError(directory, 'missing-or-unreadable-directory'); return; }
    if (!info.isDirectory() || info.isSymbolicLink()) { addError(directory, 'real-directory-required'); return; }
    let entries;
    try { entries = await readdir(absolutePath, { withFileTypes: true }); } catch { addError(directory, 'unreadable-directory'); return; }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      const path = `${directory}/${entry.name}`;
      if (path === 'public/downloads') { excluded.push({ path, reason: 'downloads-require-explicit-apk' }); continue; }
      const reason = excludedPath(path);
      if (reason) { excluded.push({ path, reason }); continue; }
      if (entry.isSymbolicLink()) { addError(path, 'symbolic-link-not-allowed'); continue; }
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && sourceExtensions.test(entry.name)) await addFile(path);
      else if (entry.isFile()) excluded.push({ path, reason: 'extension-not-allowlisted' });
      else addError(path, 'regular-file-required');
    }
  }

  for (const path of configurationFiles) await addFile(path);
  for (const path of sourceDirectories) await walk(path);
  if (apk !== null) {
    if (typeof apk !== 'string' || !/^public\/downloads\/[A-Za-z0-9][A-Za-z0-9._-]*\.apk$/.test(apk)) {
      addError('public/downloads', 'invalid-explicit-apk-path');
    } else {
      let downloadInfo;
      try { downloadInfo = await lstat(resolve(root, 'public/downloads')); } catch { /* Report the missing APK below. */ }
      if (downloadInfo && (!downloadInfo.isDirectory() || downloadInfo.isSymbolicLink())) addError('public/downloads', 'real-directory-required');
      else await addFile(apk, true);
    }
  }
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  findings.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.rule.localeCompare(b.rule));
  const ready = errors.length === 0 && findings.length === 0;
  return {
    schemaVersion: 1,
    release: 'OP-0186',
    generatedAt: new Date().toISOString(),
    readyForUploadReview: ready,
    hashAlgorithm: 'sha256',
    allowlist: { directories: sourceDirectories, files: configurationFiles, explicitApk: apk },
    limits: RELEASE_LIMITS,
    candidateCount,
    fileCount: ready ? files.length : 0,
    totalBytes: ready ? totalBytes : 0,
    contentSha256: ready ? sha256(files.map(file => `${file.path}\0${file.bytes}\0${file.sha256}\n`).join('')) : null,
    files: ready ? files : [],
    excluded,
    secretScan: { passed: findings.length === 0, findings },
    errors,
    limitations: [
      'Pattern scanning is not a guarantee that every secret was found.',
      'APK contents and signing certificates are not verified by this script; verify the release APK separately.',
      'No upload, commit, build, signature verification, deployment or device test is performed.',
      'Recreate this manifest after source or APK changes and verify each hash immediately before upload.',
    ],
  };
}

async function main(args) {
  let apk = null;
  if (args.length !== 0) {
    if (args.length !== 2 || args[0] !== '--apk') throw new Error('Aufruf: node scripts/release186-manifest.mjs [--apk public/downloads/DATEI.apk]');
    apk = args[1];
  }
  const manifest = await createReleaseManifest({ apk });
  const workDirectory = resolve(projectRoot, '.work');
  await mkdir(workDirectory, { recursive: true });
  const directoryInfo = await lstat(workDirectory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error('.work muss ein echtes Projektverzeichnis sein.');
  const destination = resolve(projectRoot, outputPath);
  let existing;
  try { existing = await lstat(destination); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error('Manifestziel muss eine reguläre Datei sein.');
  await writeFile(destination, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    manifest: portablePath(relative(projectRoot, destination)),
    readyForUploadReview: manifest.readyForUploadReview,
    fileCount: manifest.fileCount,
    totalBytes: manifest.totalBytes,
    contentSha256: manifest.contentSha256,
    findings: manifest.secretScan.findings,
    errors: manifest.errors,
  }, null, 2));
  if (!manifest.readyForUploadReview) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(() => {
    // Filesystem errors can contain uncontrolled data. Keep console output redacted.
    console.error('Release-Manifest konnte nicht sicher erzeugt werden. Aufruf und lokale Dateirechte prüfen.');
    process.exitCode = 1;
  });
}
