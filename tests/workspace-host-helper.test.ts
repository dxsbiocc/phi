import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { after, afterEach, before, test } from 'node:test'

import { parseHostCapabilityProbe } from '../src/main/agent/workspace-host/probe'
import {
  FileTransferManager,
  FileTransferRegistry,
  HelperTransferDataPlane
} from '../src/main/agent/transfer'
import type { TransferDataPlane } from '../src/main/agent/transfer/data-plane'
import { createWorkspaceHostRemoteSession } from '../src/main/agent/workspace-host/remote-session'
import { SshHost } from '../src/main/agent/workspace-host/ssh-host'
import type { RemoteExecResult } from '../src/main/agent/wrappers/remote-ssh-session'
import { createLocalShellSession, installSetsidShim } from './helpers/localShellSession'
import { runWorkspaceHostContract } from './workspace-host-contract'

const execFileAsync = promisify(execFile)
const hosts = new Set<SshHost>()
let buildDirectory = ''
let helperPath = ''
let helperVersion = ''
let restoreSetsid = (): void => undefined

function helperProfile(): ReturnType<typeof parseHostCapabilityProbe> {
  return parseHostCapabilityProbe(`
__PHI_CAPABILITY_PROBE_V1_BEGIN__
platform.os=Linux
platform.arch=x86_64
storage.home_writable=1
storage.home_executable=1
probe.complete=1
__PHI_CAPABILITY_PROBE_V1_END__
`)
}

before(async () => {
  buildDirectory = await mkdtemp(join(tmpdir(), 'phi-helper-contract-build-'))
  helperPath = join(buildDirectory, 'phi-helper')
  helperVersion = (await readFile(join(process.cwd(), 'helper', 'VERSION'), 'utf8')).trim()
  await execFileAsync(
    process.execPath,
    [join(process.cwd(), 'scripts', 'helper-toolchain.mjs'), 'build', '-o', helperPath, '.'],
    {
      cwd: join(process.cwd(), 'helper'),
      env: { ...process.env, CGO_ENABLED: '0' },
      maxBuffer: 16 * 1024 * 1024
    }
  )
  const shimDirectory = join(buildDirectory, 'shim')
  await mkdir(shimDirectory)
  restoreSetsid = installSetsidShim(shimDirectory)
})

afterEach(async () => {
  const closing = [...hosts].map((host) => host.close())
  hosts.clear()
  await Promise.all(closing)
})

after(async () => {
  restoreSetsid()
  await rm(buildDirectory, { recursive: true, force: true })
})

async function createHelperHost(root: string): Promise<SshHost> {
  const canonicalRoot = await realpath(root)
  const remoteHome = join(buildDirectory, 'remote-home', basename(root))
  const agentDir = join(buildDirectory, 'agent', basename(root))
  const sessionFactory = async (): Promise<ReturnType<typeof createLocalShellSession>> => {
    const session = createLocalShellSession(canonicalRoot)
    const execute = session.exec.bind(session)
    session.exec = (command: string): Promise<RemoteExecResult> => {
      if (command.includes('__PHI_HELPER_HOME__')) {
        return Promise.resolve({
          stdout: `__PHI_HELPER_HOME__${remoteHome}\n`,
          stderr: '',
          code: 0,
          signal: null
        })
      }
      return execute(command)
    }
    return session
  }
  const profile = helperProfile()
  const host = new SshHost({
    remoteRoot: root,
    canonicalRoot,
    connect: sessionFactory,
    helper: {
      profile,
      profileKey: { hostAlias: 'local-helper', projectRoot: canonicalRoot },
      artifact: {
        version: helperVersion,
        localPath: helperPath,
        sha256: createHash('sha256')
          .update(await readFile(helperPath))
          .digest('hex')
      },
      agentDir
    }
  })
  hosts.add(host)
  return host
}

// The helper ships for Linux servers only, and its installer uses GNU tools (stat -c,
// sha256sum); this machine can stand in for such a server only when it runs Linux itself.
const LINUX_SERVER_STAND_IN = process.platform === 'linux'

if (LINUX_SERVER_STAND_IN) runWorkspaceHostContract(createHelperHost)

test(
  'legacy remote session reads text through the helper-backed WorkspaceHost',
  {
    skip: !LINUX_SERVER_STAND_IN && 'the helper installs on Linux servers only'
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'phi-helper-remote-session-'))
    try {
      const canonicalRoot = await realpath(root)
      const host = await createHelperHost(root)
      await host.fs.writeAtomic('message.txt', 'helper adapter')
      const session = createWorkspaceHostRemoteSession(host, canonicalRoot)

      assert.equal(await session.readTextFile('message.txt'), 'helper adapter')
      await session.close()
      await host.close()
      hosts.delete(host)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)

test('TS helper data plane interoperates with the Go helper for upload and download', async () => {
  const localRoot = await mkdtemp(join(tmpdir(), 'phi-helper-data-plane-local-'))
  const remoteRoot = await mkdtemp(join(tmpdir(), 'phi-helper-data-plane-remote-'))
  const canonicalRoot = await realpath(remoteRoot)
  const session = createLocalShellSession(remoteRoot)
  const fallback: TransferDataPlane = {
    id: 'ssh',
    destinationKey: (request) => `fallback:${request.transferId}`,
    async open() {
      throw new Error('capable Go helper unexpectedly selected pure SSH fallback')
    }
  }
  const plane = new HelperTransferDataPlane({
    hostId: 'contract-host',
    workspaceId: 'contract-workspace',
    remoteRoot,
    canonicalRoot,
    connect: () =>
      session.openStdio!(
        `${JSON.stringify(helperPath)} serve --root ${JSON.stringify(canonicalRoot)}`
      ),
    fallback
  })
  try {
    const content = Buffer.concat([Buffer.alloc(1024 * 1024, 0x71), Buffer.from([0, 0xff])])
    const expectedHash = createHash('sha256').update(content).digest('hex')
    const source = join(localRoot, 'source.bin')
    await writeFile(source, content)
    const upload = await new FileTransferManager({
      registry: new FileTransferRegistry(join(localRoot, 'upload-registry.json')),
      dataPlanes: [plane]
    }).enqueue({
      transferId: 'go-upload',
      direction: 'upload',
      hostKey: 'contract-host',
      dataPlaneId: plane.id,
      source: { kind: 'local-path', path: source },
      destination: {
        kind: 'remote-workspace-path',
        hostId: 'contract-host',
        workspaceId: 'contract-workspace',
        relativePath: 'result.bin'
      },
      expectedSha256: expectedHash
    }).completion
    assert.equal(upload.sha256, expectedHash)
    assert.deepEqual(await readFile(join(remoteRoot, 'result.bin')), content)

    const destination = join(localRoot, 'downloaded.bin')
    const download = await new FileTransferManager({
      registry: new FileTransferRegistry(join(localRoot, 'download-registry.json')),
      dataPlanes: [plane]
    }).enqueue({
      transferId: 'go-download',
      direction: 'download',
      hostKey: 'contract-host',
      dataPlaneId: plane.id,
      source: {
        kind: 'remote-workspace-path',
        hostId: 'contract-host',
        workspaceId: 'contract-workspace',
        relativePath: 'result.bin'
      },
      destination: { kind: 'local-path', path: destination }
    }).completion
    assert.equal(download.sha256, expectedHash)
    assert.deepEqual(await readFile(destination), content)
  } finally {
    await session.close()
    await rm(localRoot, { recursive: true, force: true })
    await rm(remoteRoot, { recursive: true, force: true })
  }
})
