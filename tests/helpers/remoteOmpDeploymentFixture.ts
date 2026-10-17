import { createHash } from 'node:crypto'
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SshHost } from '../../src/main/agent/workspace-host/ssh-host'
import type {
  RemoteOmpDeploymentOptions,
  RemoteOmpManifest
} from '../../src/main/agent/engine/rpc/runtime-deployment'
import { createLocalShellSession, installSetsidShim } from './localShellSession'
import {
  remoteHelperReadyMarkerIdentity,
  remoteHelperReadyMarkerSha256,
  serializeRemoteHelperReadyMarker,
  type RemoteHelperInstallation
} from '../../src/main/agent/remote-helper-marker'

export async function createRemoteOmpDeploymentFixture(payload?: string): Promise<{
  root: string
  runtimeRoot: string
  host: SshHost
  session: ReturnType<typeof createLocalShellSession>
  options: RemoteOmpDeploymentOptions
  payload: string
  downloads: () => number
  cleanup: () => Promise<void>
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'phi-omp-deployment-')))
  const runtimeRoot = join(root, "runtime user's root")
  await mkdir(runtimeRoot)
  const shimDir = join(root, 'setsid-shim')
  await mkdir(shimDir)
  const restoreSetsid = installSetsidShim(shimDir)
  const session = createLocalShellSession(runtimeRoot)
  const host = new SshHost({
    remoteRoot: runtimeRoot,
    canonicalRoot: runtimeRoot,
    transferHostKey: root,
    connect: async () => session
  })
  const profile = host.capabilities()
  host.capabilities = () => ({
    ...profile,
    platform: { os: 'Linux', arch: 'x86_64', libc: { name: 'glibc' } }
  })
  const helperRoot = join(runtimeRoot, 'test-helper')
  const helperDirectory = join(helperRoot, '0.1.0')
  const helperPath = join(helperDirectory, 'phi-helper')
  await mkdir(helperDirectory, { recursive: true, mode: 0o700 })
  await chmod(helperRoot, 0o700)
  await chmod(helperDirectory, 0o700)
  const guardScript = join(process.cwd(), 'tests/helpers/projectPluginGuardCli.ts')
  const guardCommand = process.execPath.includes('bun')
    ? `${JSON.stringify(process.execPath)} ${JSON.stringify(guardScript)}`
    : `${JSON.stringify(process.execPath)} --import ${JSON.stringify(join(process.cwd(), 'scripts/test-loader.mjs'))} ${JSON.stringify(guardScript)}`
  await writeFile(helperPath, `#!/bin/sh\nexec ${guardCommand} "$@"\n`, { mode: 0o700 })
  const helperIdentity = remoteHelperReadyMarkerIdentity({
    version: '0.1.0',
    sha256: createHash('sha256')
      .update(await readFile(helperPath))
      .digest('hex')
  })
  const readyMarkerPath = join(helperDirectory, '.phi-ready.json')
  await writeFile(readyMarkerPath, serializeRemoteHelperReadyMarker(helperIdentity), {
    mode: 0o600
  })
  const helperInstallation: RemoteHelperInstallation = {
    managedRoot: helperRoot,
    remotePath: helperPath,
    remoteDirectory: helperDirectory,
    readyMarkerPath,
    markerIdentity: helperIdentity,
    readyMarkerSha256: remoteHelperReadyMarkerSha256(helperIdentity)
  }
  host.managedRemoteHelper = () => helperInstallation
  host.ensureManagedRemoteHelper = async () => helperInstallation
  host.transfer.uploadFile = async (local, remote, options) => {
    options?.signal?.throwIfAborted()
    await session.uploadFile(local, remote, options)
    const size = (await stat(local)).size
    options?.onEvent?.({
      transferId: options.transferId ?? 'fixture',
      direction: 'upload',
      state: 'saved',
      bytesTransferred: size,
      totalBytes: size,
      resumedFrom: 0,
      instantaneousBytesPerSecond: 0,
      smoothedBytesPerSecond: 0
    })
    options?.signal?.throwIfAborted()
  }
  const bytes =
    payload ??
    '#!/bin/sh\n[ "$1" = "--version" ] || exit 1\n[ -z "${OMP_TEST_SECRET:-}" ] || exit 2\n[ "$HOME/agent" = "$PI_CODING_AGENT_DIR" ] || exit 3\nprintf "omp/18.10.3\\n"\n'
  const asset = {
    url: 'https://example.invalid/omp-linux-x64',
    sha256: createHash('sha256').update(bytes).digest('hex')
  }
  const manifest: RemoteOmpManifest = {
    version: '18.10.3',
    assets: { 'linux-x64': asset, 'linux-arm64': asset }
  }
  let downloads = 0
  const options: RemoteOmpDeploymentOptions = {
    runtimeHost: host,
    runtimeRoot,
    desktopVersion: manifest.version,
    cacheDir: join(root, 'cache'),
    manifest,
    uploadOptions: { hostKey: root, agentDir: join(root, 'local-state') },
    fetchImpl: async () => {
      downloads++
      const encoded = new TextEncoder().encode(bytes)
      // Several chunks exercise the actual streaming/hash/write path with no network.
      return new Response(
        new ReadableStream({
          start(controller) {
            for (let offset = 0; offset < encoded.length; offset += 31)
              controller.enqueue(encoded.slice(offset, offset + 31))
            controller.close()
          }
        }),
        { headers: { 'content-length': String(encoded.length) } }
      )
    }
  }
  return {
    root,
    runtimeRoot,
    host,
    session,
    options,
    payload: bytes,
    downloads: () => downloads,
    cleanup: async () => {
      await host.close()
      await session.close()
      restoreSetsid()
      await rm(root, { recursive: true, force: true })
    }
  }
}
