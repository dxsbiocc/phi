import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  describeEnvironment,
  readyEnvironment,
  type EnvironmentDescriptor
} from '../src/main/agent/content'
import type { EnvironmentBuilds } from '../src/main/agent/content/environment-builds'
import {
  bindAgentSession,
  ensureEnvironmentReady
} from '../src/main/agent/content/environment-gate'
import {
  currentPlatform,
  environmentVariables,
  type EnvHandle,
  type PhiPlatform
} from '../src/main/agent/envs'
import type { EnvironmentBuild } from '../src/shared/environmentBuildTypes'
import { copyMinimal, envIdFor, installReady, shell } from './helpers/fakeEnvironment'

interface Fixture {
  root: string
  environmentsDir: string
  platform: PhiPlatform
  descriptor: EnvironmentDescriptor
}

async function withFixture(body: (fixture: Fixture) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'phi-env-gate-'))
  try {
    const environmentsDir = join(root, 'environments')
    copyMinimal(join(environmentsDir, 'phi-python'))
    const platform = currentPlatform()
    const descriptor = describeEnvironment('phi:python@1', { environmentsDir, platform })
    await body({ root, environmentsDir, platform, descriptor })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function install(root: string, descriptor: EnvironmentDescriptor): EnvHandle {
  installReady(root, descriptor, { python: shell(['echo ok']) })
  return readyEnvironment(root, descriptor)
}

function idleBuilds(): EnvironmentBuilds {
  return {
    list: () => [],
    cancel() {
      return undefined
    },
    start() {
      throw new Error('must not start')
    }
  }
}

function buildingRecord(envId: string): EnvironmentBuild {
  return {
    envId,
    ref: 'phi:python@1',
    state: 'building',
    phase: 'check',
    message: 'preparing',
    startedAt: '2026-09-29T00:00:00.000Z',
    estimate: { packages: 1, cachedPackages: 0 },
    progress: { packagesDone: 0, packages: 1 }
  }
}

test('a ready environment is returned without asking or building', async () => {
  await withFixture(async ({ root, descriptor }) => {
    const handle = install(root, descriptor)
    let asked = false
    const outcome = await ensureEnvironmentReady({
      root,
      descriptor,
      ref: 'phi:python@1',
      requester: { skill: 'echo' },
      runtimeSessionId: 'runtime-1',
      builds: idleBuilds(),
      confirmBuild: async () => {
        asked = true
        return true
      },
      signal: new AbortController().signal
    })
    assert.equal(asked, false)
    assert.equal(outcome.status, 'ready')
    if (outcome.status === 'ready') assert.equal(outcome.handle.envId, handle.envId)
  })
})

test('a running build is joined without asking again', async () => {
  await withFixture(async ({ root, descriptor }) => {
    let confirmed = false
    let started: () => void = () => undefined
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve
    })
    let finish: () => void = () => undefined
    const pending = ensureEnvironmentReady({
      root,
      descriptor,
      ref: 'phi:python@1',
      requester: { skill: 'echo' },
      runtimeSessionId: 'runtime-1',
      confirmBuild: async () => {
        confirmed = true
        return true
      },
      builds: {
        list: () => [buildingRecord(envIdFor(descriptor))],
        cancel() {
          throw new Error('the running build must keep going')
        },
        start() {
          return new Promise((resolve) => {
            finish = () => resolve(install(root, descriptor))
            started()
          })
        }
      },
      signal: new AbortController().signal
    })
    await startedPromise
    assert.equal(confirmed, false)
    finish()
    const outcome = await pending
    assert.equal(outcome.status, 'ready')
  })
})

test('confirming a build installs the environment', async () => {
  await withFixture(async ({ root, descriptor }) => {
    const outcome = await ensureEnvironmentReady({
      root,
      descriptor,
      ref: 'phi:python@1',
      requester: { skill: 'echo' },
      runtimeSessionId: 'runtime-1',
      confirmBuild: async (request) => {
        assert.equal(request.skill, 'echo')
        assert.equal(request.agent, undefined)
        assert.equal(request.ref, 'phi:python@1')
        assert.equal(typeof request.estimate.packages, 'number')
        return true
      },
      builds: {
        list: () => [],
        cancel() {
          return undefined
        },
        async start(_descriptor, options) {
          assert.equal(options.requestedBy?.skill, 'echo')
          return install(root, descriptor)
        }
      },
      signal: new AbortController().signal
    })
    assert.equal(outcome.status, 'ready')
  })
})

test('declining a build reports that the user declined', async () => {
  await withFixture(async ({ root, descriptor }) => {
    const outcome = await ensureEnvironmentReady({
      root,
      descriptor,
      ref: 'phi:python@1',
      requester: { agent: 'Scanpy' },
      runtimeSessionId: 'runtime-1',
      confirmBuild: async (request) => {
        assert.equal(request.agent, 'Scanpy')
        return false
      },
      builds: {
        list: () => [],
        cancel() {
          return undefined
        },
        start() {
          throw new Error('declined builds must not start')
        }
      },
      signal: new AbortController().signal
    })
    assert.equal(outcome.status, 'notReady')
    if (outcome.status === 'notReady') {
      assert.equal(
        outcome.message,
        'environment phi:python@1 is not built; the user declined to build it now'
      )
    }
  })
})

test('a failed build is not ready and names the build error', async () => {
  await withFixture(async ({ root, descriptor }) => {
    const outcome = await ensureEnvironmentReady({
      root,
      descriptor,
      ref: 'phi:python@1',
      requester: { skill: 'echo' },
      runtimeSessionId: 'runtime-1',
      confirmBuild: async () => true,
      builds: {
        list: () => [],
        cancel() {
          return undefined
        },
        start() {
          return Promise.reject(new Error('solver exploded'))
        }
      },
      signal: new AbortController().signal
    })
    assert.equal(outcome.status, 'notReady')
    if (outcome.status === 'notReady') {
      assert.equal(outcome.message, 'environment phi:python@1 is not ready; solver exploded')
    }
  })
})

test('aborting while a build is awaited leaves the build running', async () => {
  await withFixture(async ({ root, descriptor }) => {
    let cancelled = false
    let started: () => void = () => undefined
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve
    })
    let finish: (() => void) | undefined
    const controller = new AbortController()
    const pending = ensureEnvironmentReady({
      root,
      descriptor,
      ref: 'phi:python@1',
      requester: { skill: 'echo' },
      runtimeSessionId: 'runtime-1',
      confirmBuild: async () => true,
      builds: {
        list: () => [],
        cancel() {
          cancelled = true
        },
        start() {
          return new Promise((resolve) => {
            finish = () => resolve(install(root, descriptor))
            started()
          })
        }
      },
      signal: controller.signal
    })
    await startedPromise
    controller.abort()
    const outcome = await pending
    assert.equal(outcome.status, 'aborted')
    assert.equal(cancelled, false)
    finish?.()
  })
})

test('an already aborted signal does not start a build', async () => {
  await withFixture(async ({ root, descriptor }) => {
    let started = false
    const controller = new AbortController()
    controller.abort()
    const outcome = await ensureEnvironmentReady({
      root,
      descriptor,
      ref: 'phi:python@1',
      requester: { skill: 'echo' },
      runtimeSessionId: 'runtime-1',
      confirmBuild: async () => true,
      builds: {
        list: () => [],
        cancel() {
          return undefined
        },
        start() {
          started = true
          return Promise.reject(new Error('must not start'))
        }
      },
      signal: controller.signal
    })
    assert.equal(outcome.status, 'aborted')
    assert.equal(started, false)
  })
})

test('bindSession returns the environment variables when the environment is ready', async () => {
  await withFixture(async ({ root, environmentsDir, platform, descriptor }) => {
    install(root, descriptor)
    const handle = readyEnvironment(root, descriptor)
    const result = await bindAgentSession(
      {
        runtimeSessionId: 'runtime-1',
        ref: 'phi:python@1',
        agent: 'Scanpy',
        cwd: root
      },
      { root, environmentsDir, platform }
    )
    assert.deepEqual(result, {
      ref: 'phi:python@1',
      envId: handle.envId,
      variables: environmentVariables(handle)
    })
  })
})

test('bindSession reports a decline without building', async () => {
  await withFixture(async ({ root, environmentsDir, platform }) => {
    const result = await bindAgentSession(
      {
        runtimeSessionId: 'runtime-1',
        ref: 'phi:python@1',
        agent: 'Scanpy',
        cwd: root
      },
      {
        root,
        environmentsDir,
        platform,
        confirmBuild: async (request) => {
          assert.equal(request.agent, 'Scanpy')
          assert.equal(request.skill, undefined)
          return false
        },
        builds: {
          list: () => [],
          cancel() {
            return undefined
          },
          start() {
            throw new Error('declined builds must not start')
          }
        }
      }
    )
    assert.ok('notReady' in result)
    if ('notReady' in result) {
      assert.equal(
        result.notReady.message,
        'environment phi:python@1 is not built; the user declined to build it now'
      )
      assert.equal(result.notReady.ref, 'phi:python@1')
    }
  })
})

test('bindSession rejects a skill-local environment reference', async () => {
  await withFixture(async ({ root }) => {
    await assert.rejects(
      () =>
        bindAgentSession(
          {
            runtimeSessionId: 'runtime-1',
            ref: './environment.yml',
            agent: 'Scanpy',
            cwd: root
          },
          { root }
        ),
      /\.\/environment\.yml requires a skill/
    )
  })
})
