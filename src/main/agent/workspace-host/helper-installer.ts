import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, posix, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  shellQuote,
  type RemoteExecResult,
  type RemoteStdioProcess,
  type RemoteSshSession
} from '../wrappers/remote-ssh-session'
import type { FileTransferCoordinator, TransferEvent } from '../transfer'
import { remoteTransferHostKey } from '../transfer'
import { hashLocalFile } from '../transfer/ssh-data-plane-local'
import {
  REMOTE_HELPER_READY_MARKER_FILENAME,
  REMOTE_HELPER_READY_MARKER_MODE,
  remoteHelperReadyMarkerIdentity,
  remoteHelperReadyMarkerSha256,
  serializeRemoteHelperReadyMarker,
  type RemoteHelperInstallation,
  type RemoteHelperReadyMarkerIdentity
} from '../remote-helper-marker'
import { saveCapabilityProfile, type CapabilityProfileKey } from './capability-profile-store'
import type { ProbedHostCapabilityProfile } from './probe-parse'

export {
  REMOTE_HELPER_READY_MARKER_FILENAME,
  REMOTE_HELPER_READY_MARKER_MODE,
  REMOTE_HELPER_READY_MARKER_SCHEMA,
  remoteHelperReadyMarkerIdentity,
  type RemoteHelperReadyMarkerIdentity
} from '../remote-helper-marker'

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
  signal?: AbortSignal
  onTransferEvent?: (event: TransferEvent) => void
  transferCoordinator?: FileTransferCoordinator
  helperConnect?: () => Promise<RemoteStdioProcess>
}

interface RemoteHelperManifest {
  version: string
  platforms: Readonly<Record<string, { path: string; sha256: string }>>
}

export interface RemoteHelperInstallResult {
  state: 'available' | 'degraded'
  reason: string
  remotePath?: string
  remoteDirectory?: string
  readyMarkerPath?: string
  markerIdentity?: RemoteHelperReadyMarkerIdentity
  readyMarkerSha256?: string
  installation?: RemoteHelperInstallation
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
    helperReadyMarker: undefined,
    helperManagedRoot: undefined,
    helperDirectory: undefined,
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
  if (profile.platform.os === 'unknown' || profile.platform.arch === 'unknown') {
    return 'remote platform is unknown because capability probe is incomplete; retry on next connection'
  }
  if (profile.platform.os !== 'linux') return 'remote helper supports Linux only'
  if (!['x86_64', 'amd64', 'aarch64', 'arm64'].includes(profile.platform.arch)) {
    return 'unsupported remote helper architecture'
  }
  return undefined
}

async function checkedArtifact(
  artifact: RemoteHelperArtifact,
  signal?: AbortSignal
): Promise<string | undefined> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(artifact.version)) {
    return 'remote helper version is invalid'
  }
  if (!/^[a-f0-9]{64}$/.test(artifact.sha256)) return 'remote helper sha256 is invalid'
  try {
    const actual = await hashLocalFile(artifact.localPath, 8 * 1024 * 1024, undefined, signal)
    return actual === artifact.sha256 ? undefined : 'bundled remote helper sha256 mismatch'
  } catch {
    signal?.throwIfAborted()
    return 'bundled remote helper is unavailable'
  }
}

function successfulProfile(
  profile: ProbedHostCapabilityProfile,
  artifact: RemoteHelperArtifact,
  managedRoot: string,
  directory: string
): ProbedHostCapabilityProfile {
  return {
    ...profile,
    helperVersion: artifact.version,
    helperReadyMarker: remoteHelperReadyMarkerIdentity(artifact),
    helperManagedRoot: managedRoot,
    helperDirectory: directory,
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
    const script = [
      'set -eu',
      'home=$(cd -- "$HOME" && pwd -P)',
      '[ "$home" = "$HOME" ] && [ -d "$home" ] && [ ! -L "$home" ] && [ -O "$home" ] || exit 1',
      'current=$home',
      'for leaf in .phi remote; do',
      '  next=$current/$leaf',
      '  if [ -e "$next" ] || [ -L "$next" ]; then [ -d "$next" ] && [ ! -L "$next" ] && [ -O "$next" ] || exit 1; else mkdir -m 700 -- "$next" || exit 1; fi',
      '  chmod 700 "$next" || exit 1',
      '  current=$(cd -- "$next" && pwd -P)',
      '  [ "$current" = "$next" ] && [ -O "$current" ] || exit 1',
      'done',
      `printf '${HOME_MARKER}%s\\n' "$current"`
    ].join('\n')
    return outputPath(await options.session.exec(`sh -c ${shellQuote(script)}`), HOME_MARKER)
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
  remotePath: string,
  stagingPath: string,
  transferId: string
): Promise<void> {
  try {
    const remoteRoot = posix.dirname(remotePath)
    await options.session.uploadFile(options.artifact.localPath, stagingPath, {
      transferId,
      expectedSha256: options.artifact.sha256,
      remoteRoot,
      canonicalRoot: remoteRoot,
      hostKey: remoteTransferHostKey(options.profileKey.hostAlias),
      workspaceId: createHash('sha256').update(options.profileKey.projectRoot).digest('hex'),
      signal: options.signal,
      onEvent: options.onTransferEvent,
      coordinator: options.transferCoordinator,
      agentDir: options.agentDir,
      helperConnect: options.helperConnect,
      reuseVerifiedDestination: true,
      forceSsh: true
    })
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
  const identity = createHash('sha256')
    .update(options.profileKey.hostAlias)
    .update('\0')
    .update(options.profileKey.projectRoot)
    .update('\0')
    .update(remotePath)
    .update('\0')
    .update(options.artifact.sha256)
    .digest('hex')
  const stagingPath = `${remotePath}.upload-${identity.slice(0, 24)}`
  const transferId = `helper-${identity.slice(0, 40)}`
  let failure: unknown
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await uploadAttempt(options, remotePath, stagingPath, transferId)
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

async function publishReadyMarker(
  session: RemoteSshSession,
  remoteDirectory: string,
  remotePath: string,
  identity: RemoteHelperReadyMarkerIdentity
): Promise<string> {
  const markerPath = posix.join(remoteDirectory, REMOTE_HELPER_READY_MARKER_FILENAME)
  const temporaryTemplate = posix.join(
    remoteDirectory,
    `${REMOTE_HELPER_READY_MARKER_FILENAME}.tmp.XXXXXX`
  )
  const document = serializeRemoteHelperReadyMarker(identity)
  const script = [
    'set -eu',
    `actual=$(sha256sum ${shellQuote(remotePath)})`,
    'actual=${actual%% *}',
    `[ "$actual" = ${shellQuote(identity.sha256)} ] || exit 74`,
    `temporary=$(mktemp ${shellQuote(temporaryTemplate)})`,
    `trap 'rm -f -- "$temporary"' EXIT HUP INT TERM`,
    `printf '%s' ${shellQuote(document)} > "$temporary"`,
    `chmod ${REMOTE_HELPER_READY_MARKER_MODE.toString(8)} "$temporary"`,
    `mv -f -- "$temporary" ${shellQuote(markerPath)}`,
    'trap - EXIT HUP INT TERM'
  ].join('\n')
  const result = await session.exec(`bash -c ${shellQuote(script)}`)
  if (result.code !== 0) throw new Error('remote helper ready marker publication failed')
  return markerPath
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
    helperReadyMarker: undefined,
    helperManagedRoot: undefined,
    helperDirectory: undefined,
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
  options.session.remoteHelper = undefined
  const unsupported = unsupportedReason(options.profile)
  const reason = unsupported ?? (await checkedArtifact(options.artifact, options.signal))
  if (reason) return recordRemoteHelperFallback(options, reason)
  try {
    const managedRoot = await installationBase(options)
    const directory = posix.join(managedRoot, options.artifact.version)
    const created = await options.session.exec(
      `set -eu; umask 077; directory=${shellQuote(directory)}; if [ -e "$directory" ] || [ -L "$directory" ]; then [ -d "$directory" ] && [ ! -L "$directory" ] && [ -O "$directory" ] || exit 1; else mkdir -m 700 -- "$directory"; fi; chmod 700 "$directory"; [ "$(cd -- "$directory" && pwd -P)" = "$directory" ]`
    )
    if (created.code !== 0)
      throw new Error(
        `remote helper directory creation failed: ${created.stderr.trim() || created.code}`
      )
    const remotePath = posix.join(directory, 'phi-helper')
    const markerPath = posix.join(directory, REMOTE_HELPER_READY_MARKER_FILENAME)
    const invalidated = await options.session.exec(`rm -f ${shellQuote(markerPath)}`)
    if (invalidated.code !== 0) throw new Error('remote helper ready marker invalidation failed')
    await uploadWithRetry(options, remotePath)
    try {
      await selftest(options.session, remotePath)
    } catch (error) {
      await options.session.exec(`rm -f ${shellQuote(remotePath)}`).catch(() => undefined)
      throw error
    }
    const markerIdentity = remoteHelperReadyMarkerIdentity(options.artifact)
    const readyMarkerPath = await publishReadyMarker(
      options.session,
      directory,
      remotePath,
      markerIdentity
    )
    const readyMarkerSha256 = remoteHelperReadyMarkerSha256(markerIdentity)
    const installation: RemoteHelperInstallation = {
      managedRoot,
      remotePath,
      remoteDirectory: directory,
      readyMarkerPath,
      markerIdentity,
      readyMarkerSha256
    }
    options.session.remoteHelper = installation
    const profile = successfulProfile(options.profile, options.artifact, managedRoot, directory)
    saveCapabilityProfile(options.profileKey, profile, options.agentDir)
    return {
      state: 'available',
      reason: '',
      remotePath,
      remoteDirectory: directory,
      readyMarkerPath,
      markerIdentity,
      readyMarkerSha256,
      installation,
      profile
    }
  } catch (error) {
    return recordRemoteHelperFallback(options, reasonOf(error))
  }
}
