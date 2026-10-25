import { createHash } from 'node:crypto'
import { posix } from 'node:path'

import type { RemoteSshSession } from '../../../wrappers/remote-ssh-session'
import { shellQuote } from '../../../wrappers/remote-ssh-session'
import type { HostCapabilityProfile } from '../../../workspace-host/types'
import {
  HOST_CAPABILITY_FAST_PROBE_SCRIPT,
  parseHostCapabilityProbe
} from '../../../workspace-host/probe'
import { withDeploymentLock } from '../../rpc/runtime-deployment/deployment-lock'
import { readKernelBuild, verifyKernelBuildFile, type ResolvedKernelBuild } from './artifact'
import {
  activateKernelCommand,
  cleanupKernelStagingCommand,
  parseKernelProbeOutput,
  probePrepareReuseCommand,
  remoteKernelPaths,
  type RemoteKernelPaths
} from './commands'
import {
  RemoteKernelError,
  type RemoteKernelDeployment,
  type RemoteKernelDeploymentHost,
  type RemoteKernelDeploymentOptions,
  type RemoteKernelErrorCode,
  type RemoteKernelProfile
} from './types'

function assertRuntimeRoot(root: string): void {
  if (
    !posix.isAbsolute(root) ||
    root === '/' ||
    posix.normalize(root) !== root ||
    /[\0\r\n]/.test(root)
  ) {
    throw new RemoteKernelError(
      'INVALID_ARGUMENT',
      'Choose an absolute, canonical server runtime root.'
    )
  }
}

function assertLinuxX64Glibc(profile: HostCapabilityProfile): void {
  const { platform } = profile
  const x64 = ['x86_64', 'x64', 'amd64'].includes(platform.arch.toLowerCase())
  if (platform.os.toLowerCase() !== 'linux' || !x64 || platform.libc?.name !== 'glibc') {
    throw new RemoteKernelError(
      'UNSUPPORTED_PLATFORM',
      `Remote kernel requires Linux x64 with glibc; detected ${platform.os}/${platform.arch}/${platform.libc?.name ?? 'unknown libc'}.`
    )
  }
}

function remoteErrorCode(detail: string): RemoteKernelErrorCode {
  const marked = detail.match(/PHI_KERNEL:([A-Z_]+):/)
  const candidate = marked?.[1]
  if (
    candidate &&
    [
      'INVALID_ARGUMENT',
      'UNSUPPORTED_PLATFORM',
      'HASH_MISMATCH',
      'PERMISSION_DENIED',
      'INSUFFICIENT_SPACE',
      'REMOTE_COMMAND_FAILED'
    ].includes(candidate)
  ) {
    return candidate as RemoteKernelErrorCode
  }
  if (/no space left|disk quota/i.test(detail)) return 'INSUFFICIENT_SPACE'
  if (/permission denied|read-only file system/i.test(detail)) return 'PERMISSION_DENIED'
  return 'REMOTE_COMMAND_FAILED'
}

async function runRemoteCommand(
  host: RemoteKernelDeploymentHost,
  paths: RemoteKernelPaths,
  command: string,
  signal: AbortSignal | undefined,
  count: { value: number }
): Promise<string> {
  signal?.throwIfAborted()
  count.value++
  const result = await host.exec.run(['sh', '-c', command], {
    cwd: paths.root,
    timeoutMs: 30_000,
    maxOutputBytes: 16 * 1024,
    signal
  })
  signal?.throwIfAborted()
  if (result.code !== 0 || result.truncated || result.terminationReason) {
    const detail =
      result.stderr.trim() ||
      result.stdout.trim() ||
      result.terminationReason ||
      'remote command failed'
    throw new RemoteKernelError(
      remoteErrorCode(detail),
      `${detail}. Check the server runtime root setting (${paths.root}).`
    )
  }
  return result.stdout
}

export async function ensureRemoteKernelDeployment(
  options: RemoteKernelDeploymentOptions
): Promise<RemoteKernelDeployment> {
  assertRuntimeRoot(options.runtimeRoot)
  assertLinuxX64Glibc(options.runtimeHost.capabilities())
  const key = `${options.uploadOptions?.hostKey ?? ''}\0${options.runtimeRoot}\0${options.buildDirectory}`
  return withDeploymentLock(key, options.signal, () => deploy(options))
}

function deploymentResult(
  build: ResolvedKernelBuild,
  paths: RemoteKernelPaths,
  profile: RemoteKernelProfile,
  reused: boolean,
  remoteCommandCount: number
): RemoteKernelDeployment {
  return {
    phiVersion: build.manifest.phiVersion,
    kernelSha256: build.kernel.sha256,
    executablePath: paths.executable,
    nativePath: paths.nativeByVariant[profile.variant],
    homePath: paths.home,
    agentDir: paths.agentDir,
    profile,
    variant: profile.variant,
    reused,
    remoteCommandCount
  }
}

function transferId(hostKey: string | undefined, remote: string, sha256: string): string {
  return `kernel-${createHash('sha256')
    .update(hostKey ?? '')
    .update('\0')
    .update(remote)
    .update('\0')
    .update(sha256)
    .digest('hex')
    .slice(0, 40)}`
}

function deploymentFailure(error: unknown): RemoteKernelError {
  if (error instanceof RemoteKernelError) return error
  const message = error instanceof Error ? error.message : String(error)
  const reportedCode =
    typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined
  let code: RemoteKernelErrorCode = 'REMOTE_COMMAND_FAILED'
  if (reportedCode === 'HASH_MISMATCH' || /hash|checksum/i.test(message)) code = 'HASH_MISMATCH'
  else if (/no space left|disk quota/i.test(message)) code = 'INSUFFICIENT_SPACE'
  else if (/permission denied|read-only file system/i.test(message)) code = 'PERMISSION_DENIED'
  return new RemoteKernelError(code, message, {
    cause: error instanceof Error ? error : undefined
  })
}

async function uploadAndActivate(
  options: RemoteKernelDeploymentOptions,
  build: ResolvedKernelBuild,
  paths: RemoteKernelPaths,
  profile: RemoteKernelProfile,
  count: { value: number }
): Promise<void> {
  const { runtimeHost: host, signal } = options
  if (!host.transfer) {
    throw new RemoteKernelError(
      'INVALID_ARGUMENT',
      'Runtime host has no streaming file transfer transport.'
    )
  }
  const selectedNative = build.natives[profile.variant]
  const kernelLocal = await verifyKernelBuildFile(build, build.kernel)
  const nativeLocal = await verifyKernelBuildFile(build, selectedNative)
  const uploads = [
    {
      role: 'kernel' as const,
      local: kernelLocal,
      remote: paths.stagingKernel,
      sha256: build.kernel.sha256
    },
    {
      role: 'native' as const,
      local: nativeLocal,
      remote: paths.stagingNativeByVariant[profile.variant],
      sha256: selectedNative.sha256
    }
  ]
  try {
    for (const upload of uploads) {
      signal?.throwIfAborted()
      options.onProgress?.({
        phase: 'uploading',
        file: upload.role,
        variant: profile.variant
      })
      await host.transfer.uploadFile(upload.local, upload.remote, {
        ...options.uploadOptions,
        transferId: transferId(options.uploadOptions?.hostKey, upload.remote, upload.sha256),
        expectedSha256: upload.sha256,
        remoteRoot: options.runtimeRoot,
        signal,
        reuseVerifiedDestination: true
      })
    }
    options.onProgress?.({ phase: 'verifying', variant: profile.variant })
    await runRemoteCommand(
      host,
      paths,
      activateKernelCommand(
        paths,
        build.manifest.phiVersion,
        build.kernel,
        selectedNative,
        profile.variant
      ),
      signal,
      count
    )
  } catch (error) {
    await runRemoteCommand(
      host,
      paths,
      cleanupKernelStagingCommand(paths, profile.variant),
      undefined,
      count
    ).catch(() => undefined)
    signal?.throwIfAborted()
    throw deploymentFailure(error)
  }
}

async function deploy(options: RemoteKernelDeploymentOptions): Promise<RemoteKernelDeployment> {
  const { runtimeHost: host, signal } = options
  signal?.throwIfAborted()
  const build = await readKernelBuild(options.buildDirectory)
  const paths = remoteKernelPaths(
    options.runtimeRoot,
    build.manifest.phiVersion,
    build.kernel,
    build.natives
  )
  const count = { value: 0 }
  options.onProgress?.({ phase: 'checking' })
  const probe = parseKernelProbeOutput(
    await runRemoteCommand(
      host,
      paths,
      probePrepareReuseCommand(paths, build.manifest.phiVersion, build.kernel, build.natives),
      signal,
      count
    )
  )
  if (!probe.reused) await uploadAndActivate(options, build, paths, probe.profile, count)
  options.onProgress?.({ phase: 'ready', variant: probe.profile.variant })
  return deploymentResult(build, paths, probe.profile, probe.reused, count.value)
}

export function remoteKernelHostFromSshSession(
  session: Pick<RemoteSshSession, 'exec' | 'execBounded' | 'uploadFile'>,
  profile: HostCapabilityProfile
): RemoteKernelDeploymentHost {
  return {
    capabilities: () => profile,
    exec: {
      async run(command, options) {
        options.signal?.throwIfAborted()
        if (command[0] !== 'sh' || command[1] !== '-c' || command.length !== 3) {
          throw new RemoteKernelError('INVALID_ARGUMENT', 'Kernel deployment requires sh -c.')
        }
        const remoteCommand = `cd -- ${shellQuote(options.cwd)} && sh -c ${shellQuote(command[2])}`
        const result = session.execBounded
          ? await session.execBounded(remoteCommand, {
              timeoutMs: options.timeoutMs ?? 30_000,
              maxOutputBytes: options.maxOutputBytes ?? 16 * 1024,
              signal: options.signal
            })
          : await session.exec(remoteCommand)
        options.signal?.throwIfAborted()
        const stdoutTruncated = 'stdoutTruncated' in result && result.stdoutTruncated
        const stderrTruncated = 'stderrTruncated' in result && result.stderrTruncated
        return {
          stdout: result.stdout,
          stderr: result.stderr,
          code: result.code,
          signal: result.signal,
          truncated: Boolean(stdoutTruncated || stderrTruncated),
          ...(stdoutTruncated ? { stdoutTruncated: true } : {}),
          ...(stderrTruncated ? { stderrTruncated: true } : {})
        }
      }
    },
    transfer: {
      uploadFile: (localPath, remotePath, uploadOptions) =>
        session.uploadFile(localPath, remotePath, uploadOptions)
    }
  }
}

export async function probeRemoteKernelHostProfile(
  session: Pick<RemoteSshSession, 'exec' | 'execWithInput'>,
  signal?: AbortSignal
): Promise<HostCapabilityProfile> {
  signal?.throwIfAborted()
  const result = session.execWithInput
    ? await session.execWithInput('sh -s', HOST_CAPABILITY_FAST_PROBE_SCRIPT, {
        signal,
        timeoutMs: 10_000,
        maxOutputBytes: 64 * 1024
      })
    : await session.exec(`sh -c ${shellQuote(HOST_CAPABILITY_FAST_PROBE_SCRIPT)}`)
  signal?.throwIfAborted()
  const parsed = parseHostCapabilityProbe(result.stdout)
  if (
    result.code !== 0 ||
    parsed.probe?.state === 'unavailable' ||
    parsed.platform.os === 'unknown' ||
    parsed.platform.arch === 'unknown'
  ) {
    throw new RemoteKernelError(
      'UNSUPPORTED_PLATFORM',
      'Unable to safely detect the remote kernel platform.'
    )
  }
  return parsed
}
