import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, posix, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  shellQuote,
  type RemoteExecResult,
  type RemoteSshSession
} from '../wrappers/remote-ssh-session'
import { saveCapabilityProfile, type CapabilityProfileKey } from './capability-profile-store'
import type { ProbedHostCapabilityProfile } from './probe-parse'

const AFFECTED_CAPABILITIES = ['fs', 'exec', 'background'] as const

export interface RemoteHelperArtifact {
  version: string
  localPath: string
  sha256: string
}

export interface RemoteHelperInstallOptions {
  session: RemoteSshSession
  profile: ProbedHostCapabilityProfile
  profileKey: CapabilityProfileKey
  artifact: RemoteHelperArtifact
  agentDir?: string
}

interface RemoteHelperManifest {
  version: string
  platforms: Readonly<Record<string, { path: string; sha256: string }>>
}

export interface RemoteHelperInstallResult {
  state: 'available' | 'degraded'
  reason: string
  remotePath?: string
  profile: ProbedHostCapabilityProfile
}

const HOME_MARKER = '__PHI_HELPER_HOME__'
const ALTERNATE_MARKER = '__PHI_HELPER_ALTERNATE__'

function fallbackProfile(
  profile: ProbedHostCapabilityProfile,
  artifact: RemoteHelperArtifact,
  reason: string
): ProbedHostCapabilityProfile {
  const fallback = `${reason}; using pure SSH fallback`
  return {
    ...profile,
    helperVersion: artifact.version,
    helperStatus: {
      state: 'degraded',
      reason,
      version: artifact.version,
      affectedCapabilities: AFFECTED_CAPABILITIES
    },
    fs: { state: 'degraded', reason: fallback },
    exec: { state: 'degraded', reason: fallback },
    background: { state: 'degraded', reason: fallback }
  }
}

function unsupportedReason(profile: ProbedHostCapabilityProfile): string | undefined {
  if (profile.platform.os !== 'linux') return 'remote helper supports Linux only'
  if (!['x86_64', 'amd64', 'aarch64', 'arm64'].includes(profile.platform.arch)) {
    return 'unsupported remote helper architecture'
  }
  return undefined
}

function checkedArtifact(artifact: RemoteHelperArtifact): string | undefined {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(artifact.version)) {
    return 'remote helper version is invalid'
  }
  if (!/^[a-f0-9]{64}$/.test(artifact.sha256)) return 'remote helper sha256 is invalid'
  try {
    const actual = createHash('sha256').update(readFileSync(artifact.localPath)).digest('hex')
    return actual === artifact.sha256 ? undefined : 'bundled remote helper sha256 mismatch'
  } catch {
    return 'bundled remote helper is unavailable'
  }
}

function successfulProfile(
  profile: ProbedHostCapabilityProfile,
  artifact: RemoteHelperArtifact
): ProbedHostCapabilityProfile {
  return {
    ...profile,
    helperVersion: artifact.version,
    helperStatus: {
      state: 'available',
      version: artifact.version,
      affectedCapabilities: []
    },
    fs: { state: 'available' },
    exec: { state: 'available' },
    background: { state: 'available' }
  }
}

function outputPath(result: RemoteExecResult, marker: string): string {
  if (result.code !== 0) throw new Error(result.stderr.trim() || 'remote directory unavailable')
  const line = result.stdout.split(/\r?\n/).find((entry) => entry.startsWith(marker))
  const path = line?.slice(marker.length)
  if (!path || !posix.isAbsolute(path) || path.includes('\0')) {
    throw new Error('remote directory probe returned an invalid path')
  }
  return posix.normalize(path)
}

async function installationBase(options: RemoteHelperInstallOptions): Promise<string> {
  const storage = options.profile.storage
  if (storage.homeWritable.state === 'available' && storage.homeExecutable.state === 'available') {
    const result = await options.session.exec(`printf '${HOME_MARKER}%s\\n' "$HOME"`)
    return posix.join(outputPath(result, HOME_MARKER), '.phi', 'remote')
  }
  const script = [
    'set -eu',
    'uid=$(id -u)',
    `case "$uid" in ''|*[!0-9]*) exit 1 ;; esac`,
    'base=${TMPDIR:-/tmp}/phi-remote-$uid',
    'umask 077',
    'if [ -e "$base" ] || [ -L "$base" ]; then [ -d "$base" ] && [ ! -L "$base" ] && [ -O "$base" ] || exit 1; else mkdir "$base"; fi',
    '[ -O "$base" ] && [ ! -L "$base" ] || exit 1',
    'chmod 700 "$base"',
    'cd -P -- "$base"',
    '[ -O "$PWD" ] && [ ! -L "$PWD" ] || exit 1',
    '[ "$(stat -c %a -- "$PWD")" = 700 ] || exit 1',
    `printf '${ALTERNATE_MARKER}%s\\n' "$PWD"`
  ].join('\n')
  return outputPath(await options.session.exec(`bash -c ${shellQuote(script)}`), ALTERNATE_MARKER)
}

function remoteHash(result: RemoteExecResult): string | undefined {
  if (result.code !== 0) return undefined
  return result.stdout.match(/^([a-f0-9]{64})(?:\s|$)/)?.[1]
}

async function uploadAttempt(
  options: RemoteHelperInstallOptions,
  remotePath: string
): Promise<void> {
  const stagingPath = `${remotePath}.upload-${randomUUID()}`
  try {
    await options.session.uploadFile(options.artifact.localPath, stagingPath)
    const hash = remoteHash(await options.session.exec(`sha256sum ${shellQuote(stagingPath)}`))
    if (hash !== options.artifact.sha256) throw new Error('uploaded remote helper sha256 mismatch')
    const activation = await options.session.exec(
      `chmod 700 ${shellQuote(stagingPath)} && mv -f ${shellQuote(stagingPath)} ${shellQuote(remotePath)}`
    )
    if (activation.code !== 0) throw new Error('remote helper activation failed')
  } catch (error) {
    await options.session.exec(`rm -f ${shellQuote(stagingPath)}`).catch(() => undefined)
    throw error
  }
}

async function uploadWithRetry(
  options: RemoteHelperInstallOptions,
  remotePath: string
): Promise<void> {
  let failure: unknown
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await uploadAttempt(options, remotePath)
      return
    } catch (error) {
      failure = error
    }
  }
  throw failure
}

async function selftest(session: RemoteSshSession, remotePath: string): Promise<void> {
  const result = await session.exec(`${shellQuote(remotePath)} --selftest`)
  if (result.code !== 0) throw new Error('remote helper selftest failed')
  try {
    const report = JSON.parse(result.stdout.trim()) as { ok?: unknown }
    if (report.ok !== true) throw new Error('selftest report was not successful')
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'invalid JSON'
    throw new Error(`remote helper selftest returned invalid output: ${reason}`)
  }
}

function reasonOf(error: unknown): string {
  if (!(error instanceof Error) || !error.message) return 'remote helper installation failed'
  return error.message
    .replace(/(^|\s)\/(?:[^\s/]+\/)*[^\s]*/g, '$1[path]')
    .replace(/\s+/g, ' ')
    .slice(0, 240)
}

export function recordRemoteHelperFallback(
  options: Pick<RemoteHelperInstallOptions, 'profile' | 'profileKey' | 'artifact' | 'agentDir'>,
  reason: string
): RemoteHelperInstallResult {
  const safeReason = reasonOf(new Error(reason))
  const profile = fallbackProfile(options.profile, options.artifact, safeReason)
  saveCapabilityProfile(options.profileKey, profile, options.agentDir)
  return { state: 'degraded', reason: safeReason, profile }
}

export function helperPlatform(profile: ProbedHostCapabilityProfile): string | undefined {
  if (profile.platform.os !== 'linux') return undefined
  if (['x86_64', 'amd64'].includes(profile.platform.arch)) return 'linux-amd64'
  if (['aarch64', 'arm64'].includes(profile.platform.arch)) return 'linux-arm64'
  return undefined
}

export function remoteHelperResourceCandidates(
  resourcesPath: string | undefined,
  repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url)),
  allowRepositoryFallback = resourcesPath === undefined
): readonly string[] {
  const repository = join(repositoryRoot, 'resources', 'remote-helper')
  if (!resourcesPath) return [repository]
  const packaged = [join(resourcesPath, 'remote-helper')]
  return allowRepositoryFallback ? [...packaged, repository] : packaged
}

function electronApplication(): { isPackaged: boolean; getAppPath(): string } | undefined {
  try {
    const electron = createRequire(import.meta.url)('electron') as
      string | { app?: { isPackaged: boolean; getAppPath(): string } }
    return typeof electron === 'object' ? electron.app : undefined
  } catch {
    return undefined
  }
}

export function remoteHelperDevelopmentRoot(
  options: {
    appPath?: string
    isPackaged?: boolean
    moduleUrl?: string
  } = {}
): string | undefined {
  const app = electronApplication()
  if ((options.isPackaged ?? app?.isPackaged) === true) return undefined
  const isRepository = (root: string): boolean =>
    existsSync(join(root, 'helper', 'VERSION')) &&
    existsSync(join(root, 'scripts', 'build-helper.mjs'))
  const appPath = options.appPath ?? app?.getAppPath()
  if (appPath && isRepository(appPath)) return resolve(appPath)
  // The module can run from source or be bundled into out/main/index.mjs.
  let candidate = dirname(fileURLToPath(options.moduleUrl ?? import.meta.url))
  for (;;) {
    if (isRepository(candidate)) return candidate
    const parent = dirname(candidate)
    if (candidate === parent) return undefined
    candidate = parent
  }
}

function defaultResourceRoot(): string {
  const resourcesPath =
    typeof process.resourcesPath === 'string' ? process.resourcesPath : undefined
  const developmentRoot = remoteHelperDevelopmentRoot()
  const candidates = [
    ...(developmentRoot ? [join(developmentRoot, 'resources', 'remote-helper')] : []),
    ...(resourcesPath ? [join(resourcesPath, 'remote-helper')] : [])
  ]
  return candidates.find((root) => existsSync(join(root, 'manifest.json'))) ?? candidates[0] ?? ''
}

function containedResourcePath(root: string, path: string): string | undefined {
  if (!path || isAbsolute(path)) return undefined
  const candidate = resolve(root, path)
  const remainder = relative(resolve(root), candidate)
  return !remainder.startsWith('..') && !isAbsolute(remainder) ? candidate : undefined
}

export function resolveRemoteHelperArtifact(
  profile: ProbedHostCapabilityProfile,
  resourceRoot = defaultResourceRoot()
): RemoteHelperArtifact | undefined {
  try {
    const manifest = JSON.parse(
      readFileSync(join(resourceRoot, 'manifest.json'), 'utf8')
    ) as RemoteHelperManifest
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(manifest.version)) return undefined
    const platform = helperPlatform(profile)
    const release = platform ? manifest.platforms?.[platform] : undefined
    const localPath = release ? containedResourcePath(resourceRoot, release.path) : undefined
    if (!release || !localPath || !/^[a-f0-9]{64}$/.test(release.sha256)) {
      return {
        version: manifest.version,
        localPath: '',
        sha256: '0'.repeat(64)
      }
    }
    return { version: manifest.version, localPath, sha256: release.sha256 }
  } catch {
    return undefined
  }
}

function profileWithoutStaleHelper(
  profile: ProbedHostCapabilityProfile
): ProbedHostCapabilityProfile {
  return {
    ...profile,
    helperVersion: undefined,
    helperStatus: undefined,
    fs: { state: 'available' },
    exec: { state: 'available' },
    background: { state: 'available' }
  }
}

export function reconcileRemoteHelperProfile(
  profile: ProbedHostCapabilityProfile,
  options: {
    profileKey?: CapabilityProfileKey
    agentDir?: string
    resourceRoot?: string
  } = {}
): ProbedHostCapabilityProfile {
  const artifact = resolveRemoteHelperArtifact(profile, options.resourceRoot)
  if (!artifact || !profile.helperVersion || profile.helperVersion === artifact.version) {
    return profile
  }
  const reconciled = profileWithoutStaleHelper(profile)
  if (options.profileKey) saveCapabilityProfile(options.profileKey, reconciled, options.agentDir)
  return reconciled
}

export async function installRemoteHelper(
  options: RemoteHelperInstallOptions
): Promise<RemoteHelperInstallResult> {
  const reason = unsupportedReason(options.profile) ?? checkedArtifact(options.artifact)
  if (reason) return recordRemoteHelperFallback(options, reason)
  try {
    const directory = posix.join(await installationBase(options), options.artifact.version)
    const created = await options.session.exec(`umask 077; mkdir -p ${shellQuote(directory)}`)
    if (created.code !== 0) throw new Error('remote helper directory creation failed')
    const remotePath = posix.join(directory, 'phi-helper')
    await uploadWithRetry(options, remotePath)
    try {
      await selftest(options.session, remotePath)
    } catch (error) {
      await options.session.exec(`rm -f ${shellQuote(remotePath)}`).catch(() => undefined)
      throw error
    }
    const profile = successfulProfile(options.profile, options.artifact)
    saveCapabilityProfile(options.profileKey, profile, options.agentDir)
    return { state: 'available', reason: '', remotePath, profile }
  } catch (error) {
    return recordRemoteHelperFallback(options, reasonOf(error))
  }
}
