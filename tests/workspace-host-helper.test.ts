import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { after, afterEach, before, test } from 'node:test'

import { parseHostCapabilityProbe } from '../src/main/agent/workspace-host/probe'
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

runWorkspaceHostContract(createHelperHost)

test('legacy remote session reads text through the helper-backed WorkspaceHost', async () => {
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
})
