import assert from 'node:assert/strict'
import test from 'node:test'

import {
  RemoteJupyterServerSupervisor,
  buildRemoteJupyterLaunchScript
} from '../src/main/agent/notebook/remote-jupyter-server'
import type {
  OpenRemoteJupyterLeaseOptions,
  RemoteJupyterLease
} from '../src/main/agent/notebook/remote-jupyter-lease'
import { remoteJupyterResourceGuardActivity } from '../src/main/agent/notebook/remote-jupyter-resource-guard'

test('remote launcher applies resource limits, thread caps, monitoring, and watcher cleanup', () => {
  const script = buildRemoteJupyterLaunchScript(
    {
      command: '/opt/phi/jupyter',
      args: ['server'],
      env: { JUPYTER_RUNTIME_DIR: '/runtime/jupyter' }
    },
    52_001,
    '__PHI_JUPYTER_CLEANED_0123456789abcdef0123456789abcdef__'
  )

  assert.match(script, /prlimit --cpu=1800 --as=4294967296/u)
  assert.match(script, /ulimit -t 1800/u)
  assert.match(script, /OMP_NUM_THREADS=2/u)
  assert.match(script, /ps -eo pgid=,rss=,nlwp=,time=/u)
  assert.match(script, /kill -TERM "\$lease_shell"/u)
  assert.match(script, /kill "\$resource_watcher"/u)
  assert.match(script, /kill -KILL -"\$pid"/u)
})

test('supervisor reports monitor fallback and enforces kernel, cell, and idle gates', async () => {
  const harness = fakeLeaseHarness()
  const statuses: string[] = []
  const supervisor = new RemoteJupyterServerSupervisor({
    connection: { host: 'fake-host' },
    launch: { command: '/fake/jupyter', env: { JUPYTER_RUNTIME_DIR: '/runtime/jupyter' } },
    resourcePolicy: { maxKernels: 2, cellTimeoutMs: 123, idleTimeoutMs: 20 },
    openLease: harness.open,
    selectRemotePort: () => 52_002,
    readyProbe: async () => true,
    onStateChange: (status) => statuses.push(status.state)
  })

  await supervisor.start()
  assert.equal(supervisor.cellTimeoutMs(), 123)
  assert.equal(supervisor.status().resources.limitMode, 'monitor')
  assert.match(supervisor.status().message ?? '', /降级为 supervisor 监控/u)

  supervisor.claimKernel('one')
  supervisor.claimKernel('two')
  assert.throws(() => supervisor.claimKernel('three'), /上限 2/u)
  supervisor.releaseKernel('one')
  supervisor.releaseKernel('two')

  await waitFor(() => supervisor.status().state === 'stopped')
  assert.equal(harness.closeCalls(), 1)
  assert.ok(statuses.includes('stopping'))
  assert.equal(remoteJupyterResourceGuardActivity().timers, 0)
})

function fakeLeaseHarness(): {
  open(options: OpenRemoteJupyterLeaseOptions): Promise<RemoteJupyterLease>
  closeCalls(): number
} {
  let closes = 0
  let closed = false
  let resolveClosed!: (result: { code: number | null; signal: string | null }) => void
  const closedPromise = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    resolveClosed = resolve
  })
  const open = async (options: OpenRemoteJupyterLeaseOptions): Promise<RemoteJupyterLease> => {
    options.onLog?.('__PHI_JUPYTER_RESOURCE__:mode=monitor')
    options.onLog?.('__PHI_JUPYTER_RESOURCE__:warning=hard_limit_unavailable')
    return {
      localPort: 41_002,
      remotePort: options.remotePort,
      closed: closedPromise,
      isClosed: () => closed,
      started: () => true,
      cleanupConfirmed: () => closed,
      localSpawnFailed: () => false,
      forwardFailureConfirmed: () => false,
      close: async () => {
        if (closed) return
        closes += 1
        closed = true
        resolveClosed({ code: 0, signal: null })
      }
    }
  }
  return { open, closeCalls: () => closes }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
