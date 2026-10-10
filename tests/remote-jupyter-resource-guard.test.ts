import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

import {
  DEFAULT_REMOTE_JUPYTER_RESOURCE_POLICY,
  RemoteJupyterKernelLimitError,
  RemoteJupyterProcessResourceMonitor,
  RemoteJupyterResourceGate,
  buildRemoteJupyterResourceCleanupLines,
  buildRemoteJupyterResourceLaunchLines,
  parseRemoteJupyterResourceMarker,
  remoteJupyterResourceGuardActivity
} from '../src/main/agent/notebook/remote-jupyter-resource-guard'

const execFileAsync = promisify(execFile)

test('resource defaults are conservative and remain configurable', () => {
  assert.deepEqual(DEFAULT_REMOTE_JUPYTER_RESOURCE_POLICY, {
    maxKernels: 2,
    maxThreads: 16,
    blasThreads: 2,
    maxRssBytes: 4 * 1024 ** 3,
    maxCpuSeconds: 30 * 60,
    idleTimeoutMs: 30 * 60 * 1_000,
    cellTimeoutMs: 30 * 60 * 1_000,
    monitorIntervalMs: 5_000,
    requireHardLimits: false
  })

  const gate = new RemoteJupyterResourceGate({ maxKernels: 3, cellTimeoutMs: 123 })
  assert.equal(gate.resourceStatus().policy.maxKernels, 3)
  assert.equal(gate.cellTimeoutMs(), 123)
  gate.dispose()
})

test('kernel claims fail closed at the configured concurrent limit', () => {
  const gate = new RemoteJupyterResourceGate({ maxKernels: 2, idleTimeoutMs: 60_000 })
  gate.claimKernel('notebook-a')
  gate.claimKernel('notebook-b')
  assert.throws(() => gate.claimKernel('notebook-c'), RemoteJupyterKernelLimitError)
  assert.equal(gate.resourceStatus().activeKernels, 2)

  gate.releaseKernel('notebook-a')
  gate.claimKernel('notebook-c')
  assert.equal(gate.resourceStatus().activeKernels, 2)
  gate.dispose()
  assert.equal(remoteJupyterResourceGuardActivity().timers, 0)
})

test('idle timeout fires once and disposal leaves no timer handle', async () => {
  let idleCalls = 0
  const gate = new RemoteJupyterResourceGate(
    { idleTimeoutMs: 15 },
    { onIdle: () => void (idleCalls += 1) }
  )
  gate.touchActivity()
  await waitFor(() => idleCalls === 1)
  assert.equal(gate.resourceStatus().idleArmed, false)
  gate.dispose()
  assert.equal(remoteJupyterResourceGuardActivity().timers, 0)
})

test('idle timeout is armed only after the last kernel is released', async () => {
  let idleCalls = 0
  const gate = new RemoteJupyterResourceGate(
    { idleTimeoutMs: 15 },
    { onIdle: () => void (idleCalls += 1) }
  )
  gate.claimKernel('notebook-a')
  await new Promise((resolve) => setTimeout(resolve, 25))
  assert.equal(idleCalls, 0)
  assert.equal(gate.resourceStatus().idleArmed, false)

  gate.releaseKernel('notebook-a')
  await waitFor(() => idleCalls === 1)
  gate.dispose()
  assert.equal(remoteJupyterResourceGuardActivity().timers, 0)
})

test('prlimit rejection degrades explicitly to monitor and an RSS breach terminates', async () => {
  const events: string[] = []
  const terminations: string[] = []
  const monitor = new RemoteJupyterProcessResourceMonitor({
    policy: { monitorIntervalMs: 5, maxRssBytes: 100 },
    applyLimit: async () => false,
    sample: async () => ({ rssBytes: 101, threads: 1, cpuSeconds: 1 }),
    terminate: async (reason) => void terminations.push(reason),
    onEvent: (event) => events.push(`${event.type}:${'code' in event ? event.code : event.mode}`)
  })

  await monitor.start()
  await waitFor(() => terminations.length === 1)
  assert.deepEqual(events.slice(0, 2), ['mode:monitor', 'warning:hard_limit_unavailable'])
  assert.match(terminations[0], /rss/u)
  await monitor.stop()
  assert.equal(remoteJupyterResourceGuardActivity().timers, 0)
})

test('process-group thread and CPU samples terminate at their configured limits', async () => {
  const samples = [
    { sample: { rssBytes: 1, threads: 17, cpuSeconds: 1 }, expected: 'threads' },
    { sample: { rssBytes: 1, threads: 1, cpuSeconds: 1_801 }, expected: 'cpu' }
  ] as const

  for (const entry of samples) {
    const terminations: string[] = []
    const monitor = new RemoteJupyterProcessResourceMonitor({
      policy: { monitorIntervalMs: 5 },
      applyLimit: async () => true,
      sample: async () => entry.sample,
      terminate: async (reason) => void terminations.push(reason)
    })
    await monitor.start()
    await waitFor(() => terminations.length === 1)
    assert.deepEqual(terminations, [entry.expected])
    await monitor.stop()
  }
  assert.equal(remoteJupyterResourceGuardActivity().timers, 0)
})

test('prlimit is preferred and a sampling failure is fail-closed', async () => {
  const attempted: string[] = []
  const terminations: string[] = []
  const monitor = new RemoteJupyterProcessResourceMonitor({
    policy: { monitorIntervalMs: 5 },
    applyLimit: async (mode) => {
      attempted.push(mode)
      return mode === 'prlimit'
    },
    sample: async () => {
      throw new Error('fake ps denied')
    },
    terminate: async (reason) => void terminations.push(reason)
  })

  await monitor.start()
  await waitFor(() => terminations.length === 1)
  assert.deepEqual(attempted, ['prlimit'])
  assert.match(terminations[0], /monitor_unavailable/u)
  await monitor.stop()
})

test('server launch fragment prefers hard limits and always keeps a low-frequency monitor', () => {
  const lines = buildRemoteJupyterResourceLaunchLines("'/opt/phi/jupyter' 'server'")
  const script = lines.join('\n')
  assert.match(script, /command -v prlimit/u)
  assert.match(script, /prlimit --cpu=1800 --as=4294967296/u)
  assert.match(script, /ulimit -t 1800/u)
  assert.match(script, /ulimit -v 4194304/u)
  assert.match(script, /OMP_NUM_THREADS=2/u)
  assert.match(script, /ps -eo pgid=,rss=,nlwp=,time=/u)
  assert.match(script, /sleep 5/u)
  assert.match(script, /hard_limit_unavailable/u)
  assert.match(script, /kill -TERM -"\$pid"/u)
})

test('a site policy requiring hard limits fails before starting an unlimited process', () => {
  const script = buildRemoteJupyterResourceLaunchLines("'/opt/phi/jupyter' 'server'", {
    requireHardLimits: true
  }).join('\n')

  assert.match(script, /violation=hard_limit_required/u)
  assert.match(script, /exit 74/u)
  assert.doesNotMatch(script, /^ {2}setsid .*jupyter.* &$/mu)
})

test('fake prlimit rejection and fake ps breach report fallback before terminating', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phi-resource-guard-'))
  const trace = join(root, 'trace')
  const stubbornPid = join(root, 'stubborn.pid')
  try {
    await installExecutable(
      join(root, 'prlimit'),
      '#!/bin/sh\nprintf "prlimit\\n" >> "$PHI_RESOURCE_TRACE"\nexit 1\n'
    )
    await installExecutable(
      join(root, 'ps'),
      '#!/bin/sh\nprintf "ps\\n" >> "$PHI_RESOURCE_TRACE"\nprintf "ignored\\n"\n'
    )
    await installExecutable(join(root, 'awk'), '#!/bin/sh\ncat >/dev/null\nprintf "101 1 1\\n"\n')
    await installExecutable(
      join(root, 'setsid'),
      '#!/usr/bin/perl\nuse POSIX;\nPOSIX::setsid();\nopen(my $fh, ">", $ENV{"PHI_STUBBORN_PID"}) or die $!;\nprint $fh "$$\\n";\nclose $fh;\nexec @ARGV or die "exec: $!";\n'
    )
    const stubborn = join(root, 'stubborn')
    await installExecutable(stubborn, '#!/bin/sh\ntrap "" TERM\nwhile :; do /bin/sleep 1; done\n')
    const script = [
      'ulimit() { return 1; }',
      ...buildRemoteJupyterResourceLaunchLines(`'${stubborn}'`, {
        maxRssBytes: 100,
        monitorIntervalMs: 10
      }),
      'wait "$pid" 2>/dev/null || true',
      ...buildRemoteJupyterResourceCleanupLines()
    ].join('\n')

    const { stdout } = await execFileAsync('/bin/sh', ['-c', script], {
      env: {
        ...process.env,
        PATH: `${root}:/bin:/usr/bin`,
        PHI_RESOURCE_TRACE: trace,
        PHI_STUBBORN_PID: stubbornPid
      },
      timeout: 10_000
    })
    assert.match(stdout, /warning=hard_limit_unavailable/u)
    assert.match(stdout, /mode=monitor/u)
    assert.match(stdout, /violation=rss/u)
    assert.deepEqual((await readFile(trace, 'utf8')).trim().split('\n'), ['prlimit', 'ps'])
    assert.equal(pidIsAlive(Number(await readFile(stubbornPid, 'utf8'))), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('resource markers expose mode, degradation, and violations without arbitrary text', () => {
  assert.deepEqual(parseRemoteJupyterResourceMarker('__PHI_JUPYTER_RESOURCE__:mode=ulimit'), {
    type: 'mode',
    mode: 'ulimit'
  })
  assert.deepEqual(
    parseRemoteJupyterResourceMarker('__PHI_JUPYTER_RESOURCE__:warning=hard_limit_unavailable'),
    { type: 'warning', code: 'hard_limit_unavailable' }
  )
  assert.deepEqual(parseRemoteJupyterResourceMarker('__PHI_JUPYTER_RESOURCE__:violation=threads'), {
    type: 'violation',
    code: 'threads'
  })
  assert.equal(parseRemoteJupyterResourceMarker('untrusted=secret'), undefined)
})

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function installExecutable(path: string, source: string): Promise<void> {
  await writeFile(path, source, 'utf8')
  await chmod(path, 0o755)
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
