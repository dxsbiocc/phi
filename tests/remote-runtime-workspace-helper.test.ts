import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { openRemoteRuntimeWorkspace } from '../src/main/agent/remote-runtime/workspace'
import { HOST_CAPABILITY_FAST_PROBE_SCRIPT } from '../src/main/agent/workspace-host/probe'
import {
  FAST_PROBE_END_SENTINEL,
  FAST_PROBE_START_SENTINEL
} from '../src/main/agent/workspace-host/probe-script'
import { createLocalShellSession, installSetsidShim } from './helpers/localShellSession'
import type { LocalShellSession } from './helpers/localShellSession'
import { buildRealHelperBinary, type RealHelperBinary } from './helpers/realHelperBinary'

// Opens the REAL production opener (not a fixture host) and asks the runtime host for the
// managed helper that RPC startup requires (ssh-stdio-factory.ts).

const linuxProbe = `${FAST_PROBE_START_SENTINEL}\nplatform.os=Linux\nplatform.arch=x86_64\nprobe.fast_complete=1\n${FAST_PROBE_END_SENTINEL}`
const LINUX_SERVER_STAND_IN = process.platform === 'linux'

let scratch = ''
let helper: RealHelperBinary
let restoreSetsid = (): void => undefined

before(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'phi-runtime-workspace-helper-')))
  await mkdir(join(scratch, 'shim'))
  restoreSetsid = installSetsidShim(join(scratch, 'shim'))
  if (LINUX_SERVER_STAND_IN) helper = await buildRealHelperBinary(join(scratch, 'build'))
})

after(async () => {
  restoreSetsid()
  await rm(scratch, { recursive: true, force: true })
})

function fakeLinuxSession(commands: string[], home: string): LocalShellSession {
  const session = createLocalShellSession()
  const run = session.exec.bind(session)
  const runWithInput = session.execWithInput!.bind(session)
  session.exec = (command, options) => {
    commands.push(command)
    if (command.includes('__PHI_HELPER_HOME__')) {
      return Promise.resolve({
        stdout: `__PHI_HELPER_HOME__${home}\n`,
        stderr: '',
        code: 0,
        signal: null
      })
    }
    return run(command, options)
  }
  session.execWithInput = (command, input, options) => {
    commands.push(command)
    if (input === HOST_CAPABILITY_FAST_PROBE_SCRIPT) {
      return Promise.resolve({ stdout: linuxProbe, stderr: '', code: 0, signal: null })
    }
    return runWithInput(command, input, options)
  }
  return session
}

async function openRuntime(
  name: string,
  bootstrap: Parameters<typeof openRemoteRuntimeWorkspace>[4]
): Promise<{
  workspace: Awaited<ReturnType<typeof openRemoteRuntimeWorkspace>>
  commands: string[]
  agentDir: string
}> {
  const root = join(scratch, name)
  const project = join(root, 'project')
  const runtime = join(root, 'runtime')
  const home = join(root, 'home')
  for (const path of [project, runtime, home]) await mkdir(path, { recursive: true })
  const agentDir = join(root, 'agent')
  const commands: string[] = []
  const workspace = await openRemoteRuntimeWorkspace(
    {
      runtimeSessionId: 'runtime-1',
      sessionId: 'session-1',
      projectId: 'project-1',
      configuredRoot: runtime
    },
    undefined,
    () => ({
      sessionId: 'session-1',
      projectId: 'project-1',
      hostAlias: 'unit-host',
      remoteRoot: project,
      canonicalRoot: project,
      cacheKey: 'unit-host',
      config: {
        remoteRoot: project,
        canonicalRoot: project,
        connect: async () => fakeLinuxSession(commands, home)
      }
    }),
    undefined,
    bootstrap?.agentDir === '<agent>' ? { ...bootstrap, agentDir } : bootstrap
  )
  return { workspace, commands, agentDir }
}

async function resourceRootFor(binary: RealHelperBinary): Promise<string> {
  const resourceRoot = join(scratch, 'resources')
  const artifact = join(resourceRoot, binary.version, 'linux-amd64', 'phi-helper')
  await mkdir(join(resourceRoot, binary.version, 'linux-amd64'), { recursive: true })
  await writeFile(artifact, await readFile(binary.path), { mode: 0o755 })
  await writeFile(
    join(resourceRoot, 'manifest.json'),
    JSON.stringify({
      version: binary.version,
      platforms: {
        'linux-amd64': {
          path: `${binary.version}/linux-amd64/phi-helper`,
          sha256: createHash('sha256')
            .update(await readFile(binary.path))
            .digest('hex')
        }
      }
    })
  )
  return resourceRoot
}

test('the production opener gives the runtime host a helper bootstrap that is attempted and explained', async () => {
  const { workspace, commands } = await openRuntime('attempt', {
    agentDir: '<agent>',
    resourceRoot: join(scratch, 'no-such-resources'),
    developmentRoot: join(scratch, 'no-such-development')
  })
  try {
    const before = commands.length
    const installed = await workspace.runtimeHost.ensureManagedRemoteHelper?.()
    assert.equal(installed, undefined, 'no artifact exists in this scenario')
    assert.ok(commands.length > before, 'the helper bootstrap must reach the remote session')
    assert.match(
      workspace.runtimeHost.managedRemoteHelperFailure?.() ?? '',
      /bundled remote helper artifact is unavailable/,
      'the reason helper installation was impossible must be recorded'
    )
  } finally {
    await workspace.close?.()
  }
})

test(
  'the production opener installs the managed helper on the runtime host',
  { skip: !LINUX_SERVER_STAND_IN && 'the helper installs on Linux servers only' },
  async () => {
    const resourceRoot = await resourceRootFor(helper)
    const { workspace } = await openRuntime('install', {
      agentDir: '<agent>',
      resourceRoot,
      developmentRoot: join(scratch, 'no-such-development')
    })
    try {
      const installation = await workspace.runtimeHost.ensureManagedRemoteHelper?.()
      assert.ok(installation, 'RPC startup requires the managed helper')
      assert.equal(installation.markerIdentity.version, helper.version)
    } finally {
      await workspace.close?.()
    }
  }
)
