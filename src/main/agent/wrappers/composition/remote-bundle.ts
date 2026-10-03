import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { RemoteSshSession } from '../remote-ssh-session'
import { shellQuote } from '../remote-ssh-session'

/**
 * Ships the assembled installed wrapper tree (`~/.phi/wrappers/tree`) to the cluster once per
 * version. Wrappers include sources by relative path — a subworkflow reaches
 * `../../../../modules/...` — so the remote needs the same tree layout, not just
 * one component. The tree is content-addressed: an unchanged tree is uploaded once
 * and shared by every run, and a changed one lands beside the old bundle so runs
 * still using it keep working.
 */

// `images` holds shared conda env files and Dockerfiles that modules reference by
// relative path (e.g. `../../../../images/differential-expression-r/environment.yml`).
const BUNDLE_ROOTS = ['modules', 'subworkflows', 'workflows', 'images']
/** Directories that are test fixtures or leftovers of local runs, never part of a runnable wrapper. */
const SKIPPED_DIRS = new Set(['tests', 'work', 'results', '.git', 'node_modules', '__pycache__'])
const SKIPPED_FILES = new Set(['.DS_Store', 'dag.mmd'])
const COMPLETE_MARKER = '.phi-bundle-complete'
const LOCK_WAIT_MS = 300_000
const LOCK_POLL_MS = 500
const LOCK_STALE_SECONDS = 60
const LOCK_HEARTBEAT_MS = 10_000
const BUNDLE_COMMAND_TIMEOUT_MS = 180_000

interface BundleManifest {
  version: 1
  hash: string
  files: Array<{ path: string; size: number; sha256: string }>
}

/** Perl is already required by the remote workspace path checks; verify every file on the host. */
const VERIFY_PERL = String.raw`
use strict;
use warnings;
use JSON::PP qw(decode_json);
use Digest::SHA qw(sha256_hex);
use File::Find;
use Fcntl qw(S_IFMT S_IFREG S_IFDIR);
my ($root, $digest, $hash, @scope) = @ARGV;
# With a scope (relative directories), only files under it are read and checked for extras;
# the manifest itself is still verified in full. No scope means the whole bundle.
sub in_scope {
  my ($path) = @_;
  return 1 unless @scope;
  for my $prefix (@scope) { return 1 if $path eq $prefix || index($path, "$prefix/") == 0; }
  return 0;
}
my @root_stat = lstat($root);
exit 10 unless @root_stat;
exit 11 unless ($root_stat[2] & S_IFMT) == S_IFDIR && -r $root && -x $root;
my $marker = "$root/.phi-bundle-complete";
my @marker_stat = lstat($marker);
exit 10 unless @marker_stat;
exit 11 unless ($marker_stat[2] & S_IFMT) == S_IFREG && $marker_stat[7] <= 16777216;
open(my $marker_file, '<:raw', $marker) or exit 12;
local $/;
my $raw = <$marker_file>;
close($marker_file);
exit 11 unless sha256_hex($raw) eq $digest;
my $manifest = eval { decode_json($raw) };
exit 11 if $@ || ref($manifest) ne 'HASH' || $manifest->{version} != 1;
exit 11 unless $manifest->{hash} eq $hash && ref($manifest->{files}) eq 'ARRAY';
my %expected;
my %listed;
for my $file (@{$manifest->{files}}) {
  exit 11 unless ref($file) eq 'HASH';
  my $path = $file->{path};
  exit 11 unless defined($path) && $path ne '' && $path !~ m{^/|(?:^|/)\.\.(?:/|$)|\0};
  exit 11 if $listed{$path}++;
  next unless in_scope($path);
  $expected{$path} = 1;
  my $name = "$root/$path";
  my @st = lstat($name);
  exit 11 unless @st && ($st[2] & S_IFMT) == S_IFREG && $st[7] == $file->{size};
  open(my $content, '<:raw', $name) or exit 12;
  my $sha = Digest::SHA->new(256);
  $sha->addfile($content);
  close($content);
  exit 11 unless $sha->hexdigest eq $file->{sha256};
}
my %seen;
my $bad = 0;
eval { find({ no_chdir => 1, wanted => sub {
  my $name = $File::Find::name;
  return if $name eq $root;
  my $path = substr($name, length($root) + 1);
  return if $path eq '.phi-bundle-complete';
  my @st = lstat($name);
  if (!@st) { $bad = 1; return; }
  my $kind = $st[2] & S_IFMT;
  if ($kind == S_IFREG) { $seen{$path} = 1; }
  elsif ($kind == S_IFDIR) { $bad = 1 unless -r $name && -x $name; }
  else { $bad = 1; }
}}, @scope ? (grep { -d $_ } map { "$root/$_" } @scope) : ($root)) };
exit 11 if $@ || $bad || keys(%seen) != keys(%expected);
for my $path (keys %expected) { exit 11 unless $seen{$path}; }
exit 0;
`

function isSkipped(name: string, isDirectory: boolean, inFixtures: boolean): boolean {
  if (inFixtures) return name === '.DS_Store'
  if (name.startsWith('.nextflow')) return true
  if (isDirectory) return SKIPPED_DIRS.has(name)
  return SKIPPED_FILES.has(name) || name.endsWith('.log')
}

/** A component's default params can point at its own fixtures (`tests/data/...`); those must ship. */
function usesTestFixtures(root: string, componentRel: string): boolean {
  const params = join(root, componentRel, 'wrapper', 'params.json')
  if (!existsSync(params)) return false
  try {
    return readFileSync(params, 'utf-8').includes('"tests/')
  } catch {
    return false
  }
}

/** Every file that belongs in the bundle, as sorted POSIX paths relative to `root`. */
export function collectBundleFiles(root: string): string[] {
  const files: string[] = []
  const walk = (relDir: string, filesOnlyBelowData = false): void => {
    let entries
    try {
      entries = readdirSync(join(root, relDir), { withFileTypes: true })
    } catch {
      return
    }
    if (!filesOnlyBelowData && usesTestFixtures(root, relDir)) walk(`${relDir}/tests/data`, true)
    for (const entry of entries) {
      if (isSkipped(entry.name, entry.isDirectory(), filesOnlyBelowData)) continue
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(rel, filesOnlyBelowData)
      else if (entry.isFile()) files.push(rel)
    }
  }
  for (const bundleRoot of BUNDLE_ROOTS) walk(bundleRoot)
  return files.sort()
}

/** 12 hex chars over the file list and contents; timestamps and permissions do not count. */
export function hashBundleFiles(root: string, files: string[]): string {
  return bundleSnapshot(root, files).hash
}

function bundleSnapshot(
  root: string,
  files: string[]
): { hash: string; text: string; digest: string } {
  const identity = createHash('sha256')
  const entries = files.map((path) => {
    if (/[\r\n\0]/.test(path)) throw new Error(`Wrapper 文件名不能包含换行或 NUL: ${path}`)
    const bytes = readFileSync(join(root, path))
    identity.update(`${path}\0`)
    identity.update(bytes)
    identity.update('\0')
    return {
      path,
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex')
    }
  })
  const hash = identity.digest('hex').slice(0, 12)
  const manifest: BundleManifest = {
    version: 1,
    hash,
    files: entries
  }
  const text = `${JSON.stringify(manifest)}\n`
  return { hash, text, digest: createHash('sha256').update(text).digest('hex') }
}

type BundleState = 'valid' | 'missing' | 'invalid'

async function verifyRemoteBundle(
  session: RemoteSshSession,
  bundleDir: string,
  hash: string,
  digest: string,
  scope: string[] = []
): Promise<BundleState> {
  const scopeArgs = scope.map((prefix) => ` ${shellQuote(prefix)}`).join('')
  const command = [
    'command -v perl >/dev/null 2>&1 || exit 12',
    `perl -e ${shellQuote(VERIFY_PERL)} -- ${shellQuote(bundleDir)} ${shellQuote(digest)} ${shellQuote(hash)}${scopeArgs}`
  ].join('\n')
  const result = session.execBounded
    ? await session.execBounded(command, {
        timeoutMs: BUNDLE_COMMAND_TIMEOUT_MS,
        maxOutputBytes: 8192
      })
    : await session.exec(command)
  if (result.code === 0) return 'valid'
  if (result.code === 10) return 'missing'
  if (result.code === 11) return 'invalid'
  throw new Error(
    `服务器无法核验 Wrapper bundle: ${(result.stderr || result.stdout).trim() || `退出码 ${result.code}`}`
  )
}

async function checkedExec(
  session: RemoteSshSession,
  command: string,
  action: string,
  timeoutMs?: number
): Promise<void> {
  const result =
    timeoutMs && session.execBounded
      ? await session.execBounded(command, { timeoutMs, maxOutputBytes: 8192 })
      : await session.exec(command)
  if (result.code !== 0) {
    throw new Error(
      `${action}: ${(result.stderr || result.stdout).trim() || `退出码 ${result.code}`}`
    )
  }
}

async function acquireBundleLock(
  session: RemoteSshSession,
  lockDir: string,
  bundleDir: string,
  hash: string,
  digest: string,
  token: string,
  scope: string[]
): Promise<boolean> {
  const deadline = Date.now() + LOCK_WAIT_MS
  const owner = `${lockDir}/owner`
  const command = [
    `if mkdir ${shellQuote(lockDir)} 2>/dev/null; then`,
    `  printf '%s' ${shellQuote(token)} > ${shellQuote(owner)} && exit 0`,
    `  rm -f ${shellQuote(owner)} 2>/dev/null || true`,
    `  rmdir ${shellQuote(lockDir)} 2>/dev/null || true`,
    '  exit 18',
    'fi',
    `test -d ${shellQuote(lockDir)} && exit 17`,
    'exit 18'
  ].join('\n')
  for (;;) {
    const result = await session.exec(command)
    if (result.code === 0) return true
    if (result.code !== 17) {
      throw new Error(`服务器无法取得 Wrapper bundle 上传锁: ${lockDir}`)
    }
    if ((await verifyRemoteBundle(session, bundleDir, hash, digest, scope)) === 'valid')
      return false
    const retired = `${lockDir}.stale-${token}`
    const reclaimed = await session.exec(
      `perl -e ${shellQuote(`my @s = lstat($ARGV[0]); exit(@s && time - $s[9] > ${LOCK_STALE_SECONDS} ? 0 : 1)`)} -- ${shellQuote(lockDir)} && mv ${shellQuote(lockDir)} ${shellQuote(retired)}`
    )
    if (reclaimed.code === 0) {
      await session.exec(`rm -rf ${shellQuote(retired)}`).catch(() => undefined)
      continue
    }
    if (Date.now() >= deadline) {
      throw new Error(`Wrapper bundle 上传锁等待超时，请检查服务器上是否有遗留锁: ${lockDir}`)
    }
    await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS))
  }
}

async function assertBundleLock(
  session: RemoteSshSession,
  lockDir: string,
  token: string
): Promise<void> {
  await checkedExec(
    session,
    `test "$(cat ${shellQuote(`${lockDir}/owner`)} 2>/dev/null)" = ${shellQuote(token)}`,
    'Wrapper bundle 上传锁已失效'
  )
}

async function releaseBundleLock(
  session: RemoteSshSession,
  lockDir: string,
  token: string
): Promise<void> {
  await session
    .exec(
      `if test "$(cat ${shellQuote(`${lockDir}/owner`)} 2>/dev/null)" = ${shellQuote(token)}; then rm -rf ${shellQuote(lockDir)}; fi`
    )
    .catch(() => undefined)
}

function buildArchive(root: string, files: string[], archivePath: string): Promise<void> {
  const listPath = `${archivePath}.list`
  writeFileSync(listPath, `${files.join('\n')}\n`)
  return new Promise((resolve, reject) => {
    execFile(
      'tar',
      ['-czf', archivePath, '-C', root, '-T', listPath],
      // macOS tar otherwise adds ._ AppleDouble files that would land in the bundle.
      { env: { ...process.env, COPYFILE_DISABLE: '1' } },
      (error, _stdout, stderr) => {
        rmSync(listPath, { force: true })
        if (error) reject(new Error(`打包 wrapper 源码失败: ${stderr || error.message}`))
        else resolve()
      }
    )
  })
}

export interface RemoteBundle {
  hash: string
  bundleDir: string
}

export async function ensureRemoteBundle(
  session: RemoteSshSession,
  input: {
    localRoot: string
    workspaceRoot: string
    /**
     * Directories (relative to the bundle root) whose files this run reads. Only these are
     * re-hashed when checking a bundle, instead of every file: on cluster shared storage a
     * full pass over a few thousand files outlasts any sensible timeout. The manifest is
     * always checked in full, and a fresh upload is checked against the archive digest.
     */
    verifyScope?: string[]
  }
): Promise<RemoteBundle> {
  const scope = (input.verifyScope ?? []).filter(
    (prefix) => prefix !== '' && !prefix.startsWith('/') && !prefix.split('/').includes('..')
  )
  const files = collectBundleFiles(input.localRoot)
  if (files.length === 0) throw new Error(`没有可上传的 wrapper 源码: ${input.localRoot}`)
  const manifest = bundleSnapshot(input.localRoot, files)
  const { hash } = manifest
  const bundlesDir = `${input.workspaceRoot.replace(/\/+$/, '')}/wrappers/bundles`
  const bundleDir = `${bundlesDir}/${hash}`
  const bundle = { hash, bundleDir }
  if ((await verifyRemoteBundle(session, bundleDir, hash, manifest.digest, scope)) === 'valid') {
    return bundle
  }

  await session.mkdirp(bundlesDir)
  const token = randomUUID()
  const lockDir = `${bundleDir}.lock`
  let ownsLock: boolean
  try {
    ownsLock = await acquireBundleLock(
      session,
      lockDir,
      bundleDir,
      hash,
      manifest.digest,
      token,
      scope
    )
  } catch (error) {
    await releaseBundleLock(session, lockDir, token)
    throw error
  }
  if (!ownsLock) {
    return bundle
  }
  let heartbeatBusy = false
  const heartbeat = setInterval(() => {
    if (heartbeatBusy) return
    heartbeatBusy = true
    void session
      .exec(
        `if test "$(cat ${shellQuote(`${lockDir}/owner`)} 2>/dev/null)" = ${shellQuote(token)}; then touch ${shellQuote(lockDir)}; fi`
      )
      .catch(() => undefined)
      .finally(() => {
        heartbeatBusy = false
      })
  }, LOCK_HEARTBEAT_MS)
  heartbeat.unref()
  let tmp: string | undefined
  const remoteArchive = `${bundleDir}.archive-${token}.tar.gz`
  const partial = `${bundleDir}.partial-${token}`
  try {
    if ((await verifyRemoteBundle(session, bundleDir, hash, manifest.digest, scope)) === 'valid') {
      return bundle
    }
    tmp = mkdtempSync(join(tmpdir(), 'phi-bundle-'))
    const localArchive = join(tmp, `${hash}.tar.gz`)
    await buildArchive(input.localRoot, files, localArchive)
    await session.uploadFile(localArchive, remoteArchive)
    const archiveDigest = createHash('sha256').update(readFileSync(localArchive)).digest('hex')
    await checkedExec(
      session,
      `test "$(perl -MDigest::SHA -e 'print Digest::SHA->new(256)->addfile($ARGV[0])->hexdigest' ${shellQuote(remoteArchive)})" = ${shellQuote(archiveDigest)}`,
      '上传的 wrapper 源码压缩包校验失败',
      BUNDLE_COMMAND_TIMEOUT_MS
    )
    await checkedExec(
      session,
      [
        'set -e',
        `mkdir ${shellQuote(partial)}`,
        `tar -xzf ${shellQuote(remoteArchive)} -C ${shellQuote(partial)}`
      ].join('\n'),
      '远程解压 wrapper 源码失败',
      BUNDLE_COMMAND_TIMEOUT_MS
    )
    await session.writeTextFile(`${partial}/${COMPLETE_MARKER}`, manifest.text)
    if ((await verifyRemoteBundle(session, partial, hash, manifest.digest, scope)) !== 'valid') {
      throw new Error('远程 Wrapper bundle 文件清单或内容校验失败')
    }
    await assertBundleLock(session, lockDir, token)
    if ((await verifyRemoteBundle(session, bundleDir, hash, manifest.digest, scope)) === 'valid') {
      return bundle
    }
    const corrupt = `${bundleDir}.corrupt-${token}`
    await checkedExec(
      session,
      [
        'set -e',
        `test ! -e ${shellQuote(corrupt)} && test ! -L ${shellQuote(corrupt)}`,
        `if [ -e ${shellQuote(bundleDir)} ] || [ -L ${shellQuote(bundleDir)} ]; then mv ${shellQuote(bundleDir)} ${shellQuote(corrupt)}; fi`,
        `mv ${shellQuote(partial)} ${shellQuote(bundleDir)}`
      ].join('\n'),
      '远程发布 Wrapper bundle 失败'
    )
    if ((await verifyRemoteBundle(session, bundleDir, hash, manifest.digest, scope)) !== 'valid') {
      throw new Error('远程 Wrapper bundle 发布后校验失败')
    }
  } finally {
    clearInterval(heartbeat)
    if (tmp) rmSync(tmp, { recursive: true, force: true })
    await session
      .exec(`rm -rf ${shellQuote(partial)}; rm -f ${shellQuote(remoteArchive)}`)
      .catch(() => undefined)
    await releaseBundleLock(session, lockDir, token)
  }
  return bundle
}
