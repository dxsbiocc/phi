import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import { describeEnvironment } from '../src/main/agent/content/environment-refs'
import { removeTree, type PhiPlatform } from '../src/main/agent/envs'
import {
  JupyterServerRegistry,
  managedLaunchResolver,
  type JupyterServerLaunch,
  type ManagedJupyterProcess
} from '../src/main/agent/notebook/analysis-jupyter-server'
import {
  JupyterEnvironmentNotReadyError,
  resolveManagedJupyterLaunch
} from '../src/main/agent/notebook/managed-jupyter-server'
import { managedKernelsDir } from '../src/main/agent/notebook/managed-kernels'
import { copyMinimal, installReady, writeExecutable } from './helpers/fakeEnvironment'

const PLATFORM: PhiPlatform = 'darwin-arm64'
const NOT_READY = 'environment phi:jupyter@1 is not ready; the user must build it first'

interface Fixture {
  base: string
  root: string
  environmentsDir: string
  project: string
}

function withFixture(body: (fixture: Fixture) => Promise<void>): () => Promise<void> {
  return async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'phi-managed-jupyter-')))
    const fixture = {
      base,
      root: join(base, 'runtime'),
      environmentsDir: join(base, 'environments'),
      project: join(base, 'project')
    }
    mkdirSync(fixture.root, { recursive: true })
    mkdirSync(fixture.project, { recursive: true })
    for (const name of ['phi-python', 'phi-r', 'phi-jupyter']) {
      copyMinimal(join(fixture.environmentsDir, name), name)
    }
    try {
      await body(fixture)
    } finally {
      removeTree(base)
    }
  }
}

function install(fixture: Fixture, ref: string): string {
  const descriptor = describeEnvironment(ref, {
    environmentsDir: fixture.environmentsDir,
    platform: PLATFORM
  })
  const envId = installReady(fixture.root, descriptor, { jupyter: 'exit 0' })
  return join(fixture.root, 'envs', envId)
}

function options(fixture: Fixture): {
  root: string
  environmentsDir: string
  platform: PhiPlatform
  baseEnv: NodeJS.ProcessEnv
  hostPlatform: NodeJS.Platform
} {
  return {
    root: fixture.root,
    environmentsDir: fixture.environmentsDir,
    platform: PLATFORM,
    baseEnv: {
      HOME: '/Users/someone',
      PATH: '/opt/homebrew/bin:/usr/bin',
      PYTHONPATH: '/host/site',
      JUPYTER_PATH: '/Users/someone/Library/Jupyter'
    },
    hostPlatform: 'darwin'
  }
}

class FakeProcess extends EventEmitter implements ManagedJupyterProcess {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly pid = 4242
  killed = false

  kill(): boolean {
    this.killed = true
    return true
  }
}

async function settle(registry: JupyterServerRegistry, project: string): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const status = registry.status(project)
    if (status.state !== 'starting') return status.state
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return registry.status(project).state
}

test(
  'the server command is the managed jupyter with its variables and Phi kernel directory',
  withFixture(async (fixture) => {
    const jupyterPrefix = install(fixture, 'phi:jupyter@1')
    const pythonPrefix = install(fixture, 'phi:python@1')
    const launch = await resolveManagedJupyterLaunch(
      { port: 31888, args: ['server', '--no-browser'] },
      options(fixture)
    )
    const kernels = managedKernelsDir(fixture.root)

    assert.equal(launch.command, join(jupyterPrefix, 'bin', 'jupyter'))
    assert.deepEqual(launch.args, [
      'server',
      '--no-browser',
      `--KernelSpecManager.kernel_dirs=${kernels}`,
      '--KernelSpecManager.ensure_native_kernel=False',
      '--MultiKernelManager.default_kernel_name=phi-python'
    ])
    assert.equal(launch.env.PATH, `${join(jupyterPrefix, 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin`)
    assert.equal(launch.env.PHI_ENV_PREFIX, jupyterPrefix)
    assert.equal(launch.env.PYTHONPATH, undefined)
    assert.equal(launch.env.HOME, '/Users/someone')
    assert.equal(launch.env.JUPYTER_PATH, join(fixture.root, 'jupyter'))
    assert.equal(launch.env.JUPYTER_DATA_DIR, join(fixture.root, 'jupyter', 'data'))
    assert.equal(launch.env.JUPYTER_CONFIG_DIR, join(fixture.root, 'jupyter', 'config'))
    assert.equal(launch.env.JUPYTER_RUNTIME_DIR, join(fixture.root, 'jupyter', 'runtime'))
    assert.ok(existsSync(join(fixture.root, 'jupyter', 'runtime')))
    // The kernelspecs are written before the server starts.
    assert.ok(existsSync(join(kernels, 'phi-python', 'kernel.json')))
    assert.ok(existsSync(join(pythonPrefix, 'bin')))
    assert.equal(existsSync(join(kernels, 'phi-r')), false)
  })
)

test(
  'a missing phi-jupyter fails with the not-ready message and never reaches the host jupyter',
  withFixture(async (fixture) => {
    await assert.rejects(
      resolveManagedJupyterLaunch({ port: 31888 }, options(fixture)),
      (error: unknown) =>
        error instanceof JupyterEnvironmentNotReadyError && error.message === NOT_READY
    )

    // A host `jupyter` on PATH that would record being run.
    const hostBin = join(fixture.base, 'host-bin')
    const marker = join(fixture.base, 'host-jupyter-ran')
    writeExecutable(join(hostBin, 'jupyter'), `touch '${marker}'`)
    const previousPath = process.env.PATH
    process.env.PATH = `${hostBin}:${previousPath ?? ''}`
    try {
      const spawned: JupyterServerLaunch[] = []
      const registry = new JupyterServerRegistry({
        resolveLaunch: managedLaunchResolver(options(fixture)),
        createProcess: (_cwd, launch) => {
          spawned.push(launch)
          return new FakeProcess()
        }
      })
      registry.start(fixture.project)
      assert.equal(await settle(registry, fixture.project), 'error')
      assert.equal(registry.status(fixture.project).message, NOT_READY)
      assert.deepEqual(spawned, [])

      // The default process factory refuses anything but a resolved managed launch.
      const unresolved = new JupyterServerRegistry({
        resolveLaunch: async (_cwd, launch) => launch
      })
      unresolved.start(fixture.project)
      assert.equal(await settle(unresolved, fixture.project), 'error')
      assert.match(
        unresolved.status(fixture.project).message ?? '',
        /not resolved to phi:jupyter@1/
      )
      assert.equal(existsSync(marker), false)
    } finally {
      process.env.PATH = previousPath
    }
  })
)

test(
  'the registry spawns the resolved managed launch, and not after a stop during resolution',
  withFixture(async (fixture) => {
    const jupyterPrefix = install(fixture, 'phi:jupyter@1')
    const spawned: JupyterServerLaunch[] = []
    const registry = new JupyterServerRegistry({
      managed: options(fixture),
      port: 31999,
      createProcess: (_cwd, launch) => {
        spawned.push(launch)
        return new FakeProcess()
      },
      resolveLaunch: managedLaunchResolver(options(fixture)),
      readyProbe: async () => false,
      readyProbeAttempts: 0
    })
    registry.start(fixture.project)
    await settle(registry, fixture.project)
    for (let attempt = 0; attempt < 50 && spawned.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.equal(spawned.length, 1)
    assert.equal(spawned[0]?.command, join(jupyterPrefix, 'bin', 'jupyter'))
    assert.ok(spawned[0]?.args?.includes('--ServerApp.port=31999'))
    assert.equal(spawned[0]?.env?.PHI_ENV_PREFIX, jupyterPrefix)

    let release: () => void = () => {}
    const slow = new JupyterServerRegistry({
      createProcess: () => {
        throw new Error('must not spawn after stop')
      },
      resolveLaunch: (_cwd, launch) =>
        new Promise((resolve) => {
          release = () => resolve({ ...launch, command: '/x/jupyter', env: {} })
        })
    })
    slow.start(fixture.project)
    slow.stop(fixture.project)
    release()
    await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(slow.status(fixture.project).state, 'stopped')
  })
)
