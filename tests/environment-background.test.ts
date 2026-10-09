import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

import { createBackgroundEnvironment } from '../src/main/agent/environment/background'
import type { EnvironmentSnapshot } from '../src/shared/environmentTypes'

const workerUrl = new URL('../src/main/agent/environment/scan-worker.ts', import.meta.url)

function temporaryEnvironment(): {
  root: string
  agentDir: string
  cleanup: () => void
} {
  const root = mkdtempSync(join(tmpdir(), 'phi-background-env-'))
  const agentDir = join(root, 'agent')
  mkdirSync(agentDir)
  return { root, agentDir, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function cachedSnapshot(agentDir: string): EnvironmentSnapshot {
  const snapshot: EnvironmentSnapshot = {
    scannedAt: '2026-10-09T00:00:00.000Z',
    firstScanCompleted: true,
    summaryDismissed: false,
    tools: [{ id: 'docker', label: 'Docker', status: 'missing', source: 'none' }],
    hostDependencies: [],
    hostTools: []
  }
  writeFileSync(join(agentDir, 'environment.json'), JSON.stringify(snapshot))
  return snapshot
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!existsSync(path)) {
    assert.ok(Date.now() < deadline, `worker did not reach ${path}`)
    await delay(10)
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    return false
  }
}

test(
  'a real environment probe runs off the event loop and preserves scan/cache/custom state',
  {
    skip: process.platform === 'win32' && 'the gated executable fixture requires a POSIX shell'
  },
  async () => {
    const fixture = temporaryEnvironment()
    const binDir = join(fixture.root, 'bin')
    const started = join(fixture.root, 'probe-started')
    const released = join(fixture.root, 'probe-released')
    const dockerPath = join(binDir, 'docker')
    const nextflowPath = join(binDir, 'custom-nextflow')
    mkdirSync(binDir)
    writeFileSync(
      join(binDir, 'which'),
      `#!/bin/sh\nif [ "$1" = docker ]; then printf '%s\\n' '${dockerPath}'; else exit 1; fi\n`,
      { mode: 0o755 }
    )
    writeFileSync(
      dockerPath,
      `#!/bin/sh\nprintf started > '${started}'\nwhile [ ! -f '${released}' ]; do /bin/sleep 0.02; done\nif [ "$1" = info ]; then printf '27.2.1\\n'; else printf 'Docker version 27.2.1\\n'; fi\n`,
      { mode: 0o755 }
    )
    writeFileSync(nextflowPath, "#!/bin/sh\nprintf 'nextflow version 26.04.6 build 1\\n'\n", {
      mode: 0o755
    })
    const previousPath = process.env.PATH
    const previousHome = process.env.HOME
    process.env.PATH = `${binDir}:/usr/bin:/bin`
    process.env.HOME = fixture.root
    const environment = createBackgroundEnvironment({ agentDir: fixture.agentDir, workerUrl })
    try {
      let finished = false
      const scanning = environment.get().then((result) => {
        finished = true
        return result
      })
      await waitForFile(started)
      await nextTurn()
      assert.equal(finished, false, 'the event loop must remain runnable during a blocked probe')
      writeFileSync(released, '')
      const first = await scanning
      assert.equal(first.showSummary, true)
      assert.equal(first.snapshot.firstScanCompleted, true)
      assert.equal(first.snapshot.tools.find(({ id }) => id === 'docker')?.activePath, dockerPath)
      assert.equal(
        first.snapshot.hostDependencies.find(({ id }) => id === 'docker')?.status,
        'ready'
      )

      rmSync(started)
      const cached = await environment.get()
      assert.deepEqual(cached, first)
      assert.equal(existsSync(started), false, 'a cached read must not run tool probes')

      const custom = await environment.setToolPath('nextflow', nextflowPath)
      assert.equal(custom.tools.find(({ id }) => id === 'nextflow')?.source, 'custom')
      assert.equal(custom.tools.find(({ id }) => id === 'nextflow')?.activePath, nextflowPath)
      assert.equal(custom.hostTools.find(({ id }) => id === 'nextflow')?.selected, true)
      const persisted = JSON.parse(readFileSync(join(fixture.agentDir, 'environment.json'), 'utf8'))
      assert.equal(persisted.customPaths.nextflow, nextflowPath)

      await environment.dismissSummary()
      const redetected = await environment.redetect()
      assert.equal(redetected.summaryDismissed, true)
      assert.equal(redetected.tools.find(({ id }) => id === 'nextflow')?.activePath, nextflowPath)
      assert.equal((await environment.get()).showSummary, false)
    } finally {
      writeFileSync(released, '')
      await environment.dispose()
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
      fixture.cleanup()
    }
  }
)

test('queued operations observe writes in order and recover from a store error', async () => {
  const fixture = temporaryEnvironment()
  const snapshot = cachedSnapshot(fixture.agentDir)
  const environment = createBackgroundEnvironment({ agentDir: fixture.agentDir, workerUrl })
  try {
    const invalidPath = environment.setToolPath('docker', 'relative/docker')
    const error = assert.rejects(invalidPath, /工具路径必须是绝对路径/)
    const beforeDismissal = environment.get()
    const dismissal = environment.dismissSummary()
    const afterDismissal = environment.get()
    await error
    assert.deepEqual((await beforeDismissal).snapshot, snapshot)
    assert.equal((await dismissal).summaryDismissed, true)
    assert.equal((await afterDismissal).showSummary, false)
    assert.equal((await afterDismissal).snapshot.scannedAt, snapshot.scannedAt)
  } finally {
    await environment.dispose()
    fixture.cleanup()
  }
})

test('a worker startup failure does not poison the operation queue', async () => {
  const fixture = temporaryEnvironment()
  cachedSnapshot(fixture.agentDir)
  const entry = join(fixture.root, 'late-worker.mjs')
  const environment = createBackgroundEnvironment({
    agentDir: fixture.agentDir,
    workerUrl: pathToFileURL(entry)
  })
  try {
    await assert.rejects(environment.get(), /Cannot find module/)
    writeFileSync(entry, `import ${JSON.stringify(workerUrl.href)}\n`)
    assert.equal((await environment.get()).snapshot.firstScanCompleted, true)
  } finally {
    await environment.dispose()
    fixture.cleanup()
  }
})

test('disposal terminates active work and rejects queued and future operations', async () => {
  const fixture = temporaryEnvironment()
  const entered = join(fixture.root, 'entered')
  const entry = join(fixture.root, 'waiting-worker.mjs')
  writeFileSync(
    entry,
    `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(entered)}, '')\nsetInterval(() => {}, 1000)\n`
  )
  const environment = createBackgroundEnvironment({
    agentDir: fixture.agentDir,
    workerUrl: pathToFileURL(entry)
  })
  try {
    const active = assert.rejects(environment.get(), /disposed/)
    const queued = assert.rejects(environment.dismissSummary(), /disposed/)
    await waitForFile(entered)
    await environment.dispose()
    await Promise.all([active, queued])
    await assert.rejects(environment.get(), /disposed/)
    await assert.rejects(environment.redetect(), /disposed/)
    await assert.rejects(environment.setToolPath('docker', null), /disposed/)
    await environment.dispose()
  } finally {
    await environment.dispose()
    fixture.cleanup()
  }
})

test(
  'disposal promptly kills an actual blocked probe and its owned scan process',
  {
    skip: process.platform === 'win32' && 'the gated executable fixture requires a POSIX shell'
  },
  async (t) => {
    const fixture = temporaryEnvironment()
    cachedSnapshot(fixture.agentDir)
    const previousCache = readFileSync(join(fixture.agentDir, 'environment.json'))
    const binDir = join(fixture.root, 'bin')
    const scanPidFile = join(fixture.root, 'scan-pid')
    const probePidFile = join(fixture.root, 'probe-pid')
    const released = join(fixture.root, 'released')
    const dockerPath = join(binDir, 'docker')
    const entry = join(fixture.root, 'scan-entry.mjs')
    mkdirSync(binDir)
    writeFileSync(
      join(binDir, 'which'),
      `#!/bin/sh\nif [ "$1" = docker ]; then printf '%s\\n' '${dockerPath}'; else exit 1; fi\n`,
      { mode: 0o755 }
    )
    writeFileSync(
      dockerPath,
      `#!/bin/sh\nprintf '%s\\n' "$$" > '${probePidFile}'\nwhile [ ! -f '${released}' ]; do /bin/sleep 0.02; done\nprintf 'Docker version 27.2.1\\n'\n`,
      { mode: 0o755 }
    )
    writeFileSync(
      entry,
      `import ${JSON.stringify(workerUrl.href)}\nimport { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(scanPidFile)}, String(process.pid))\n`
    )
    const previousPath = process.env.PATH
    const previousHome = process.env.HOME
    process.env.PATH = `${binDir}:/usr/bin:/bin`
    process.env.HOME = fixture.root
    const environment = createBackgroundEnvironment({
      agentDir: fixture.agentDir,
      workerUrl: pathToFileURL(entry)
    })
    try {
      const active = assert.rejects(environment.redetect(), /disposed/)
      const queued = assert.rejects(environment.dismissSummary(), /disposed/)
      await waitForFile(probePidFile)
      const scanPid = Number(readFileSync(scanPidFile, 'utf8'))
      const probePid = Number(readFileSync(probePidFile, 'utf8'))
      assert.equal(processExists(scanPid), true)
      assert.equal(processExists(probePid), true)
      const startedAt = performance.now()
      await environment.dispose()
      await Promise.all([active, queued])
      while (processExists(scanPid) || processExists(probePid)) {
        assert.ok(
          performance.now() - startedAt < 2_000,
          'owned scan/probe processes must exit promptly'
        )
        await delay(10)
      }
      const durationMs = performance.now() - startedAt
      assert.ok(durationMs < 2_000, 'quit must not wait for the probe timeout')
      t.diagnostic(
        `terminated the owned scan process and blocked probe in ${Math.round(durationMs)} ms`
      )
      assert.deepEqual(readFileSync(join(fixture.agentDir, 'environment.json')), previousCache)
    } finally {
      writeFileSync(released, '')
      await environment.dispose()
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
      fixture.cleanup()
    }
  }
)
