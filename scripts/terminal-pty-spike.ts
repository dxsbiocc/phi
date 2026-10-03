import { spawn } from 'node:child_process'
import { accessSync, constants, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Process, ProcessStatus, PtySession } from '@oh-my-pi/pi-natives'
import {
  FloodCollector,
  MINIMAL_PATH,
  NORMAL_TIMEOUT_MS,
  TextCollector,
  allExited,
  allowlistEnvironment,
  cleanEvidence,
  closeHandle,
  delay,
  descendants,
  emitSentinel,
  frame,
  normalizeTerminalText,
  prepareLongRunningChildren,
  shellQuote,
  startShell,
  uniqueSentinel,
  waitUntil,
  withTimeout,
  type ShellHandle
} from './terminal-pty-spike/helpers'

const REQUIRED_IDS = new Set([
  'env-semantics',
  'login-path',
  'tty',
  'stty-size',
  'state-persist',
  'utf8',
  'interactive-read',
  'ctrl-c',
  'flood-ctrl-c',
  'exit',
  'close-graceful',
  'close-quit-budget',
  'worker-crash'
])

type Result = { status: 'PASS' | 'FAIL' | 'INFO'; id: string; evidence: string }

async function runCrashWorkerChild(cwd: string): Promise<never> {
  const collector = new TextCollector()
  const handle = await startShell(cwd, allowlistEnvironment(), collector)
  process.stdout.write(`${JSON.stringify({ type: 'started', pid: handle.pid })}\n`)
  const children = await prepareLongRunningChildren(handle, { background: false })
  process.stdout.write(
    `${JSON.stringify({ type: 'ready', descendantPids: children.map((child) => child.pid) })}\n`
  )
  await handle.exitPromise
  process.exit(0)
}

function findResourceDirectories(root: string): string[] {
  const results: string[] = []
  if (!readdirSafe(root)) return results
  const visit = (directory: string, depth: number): void => {
    if (depth > 5) return
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const path = join(directory, entry.name)
      if (entry.name === 'Resources' && basename(dirname(path)) === 'Contents') results.push(path)
      else visit(path, depth + 1)
    }
  }
  visit(root, 0)
  return results
}

function readdirSafe(path: string): boolean {
  try {
    readdirSync(path)
    return true
  } catch {
    return false
  }
}

async function main(): Promise<number> {
  const results: Result[] = []
  const handles: ShellHandle[] = []
  const tempRoot = mkdtempSync(join(tmpdir(), 'phi-terminal-pty-'))
  const shell = process.env.SHELL || '/bin/zsh'
  const originalLeak = process.env.PHI_SPIKE_LEAK
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PHI_SPIKE_LEAK = '1'
  process.env.PI_CODING_AGENT_DIR = '/tmp/leak'
  const env = allowlistEnvironment()

  const record = async (id: string, check: () => Promise<string>): Promise<void> => {
    try {
      results.push({ status: 'PASS', id, evidence: cleanEvidence(await check()) })
    } catch (error) {
      results.push({
        status: 'FAIL',
        id,
        evidence: cleanEvidence(error instanceof Error ? error.message : error)
      })
    }
  }

  try {
    accessSync(shell, constants.X_OK)
    const mainShell = await startShell(tempRoot, env)
    handles.push(mainShell)
    let envOutput = ''

    await record('env-semantics', async () => {
      envOutput = await frame(mainShell, '/usr/bin/env')
      const leaked = /^(PHI_SPIKE_LEAK|PI_CODING_AGENT_DIR)=/m.test(envOutput)
      if (leaked) {
        throw new Error('startArgv env merged forbidden PHI_SPIKE_LEAK or PI_CODING_AGENT_DIR')
      }
      return `env replaces inherited worker values; PHI_SPIKE_LEAK=false PI_CODING_AGENT_DIR=false keys=${envOutput.split('\n').length}`
    })

    await record('login-path', async () => {
      if (!envOutput) envOutput = await frame(mainShell, '/usr/bin/env')
      const path = envOutput.match(/^PATH=(.*)$/m)?.[1]
      if (!path) throw new Error('PATH missing from login shell environment')
      return path === MINIMAL_PATH
        ? `PATH=${path}; unchanged because this account's login files did not rebuild it`
        : `PATH=${path}; rebuiltFromMinimal=true`
    })

    await record('tty', async () => {
      const output = await frame(mainShell, "test -t 0 && test -t 1 && printf 'TTY_OK\\n'")
      if (!output.includes('TTY_OK')) throw new Error(`TTY test output=${JSON.stringify(output)}`)
      return 'stdin=true stdout=true'
    })

    await record('stty-size', async () => {
      const before = (await frame(mainShell, 'stty size')).trim()
      mainShell.pty.resize(120, 40)
      const after = (await frame(mainShell, 'stty size')).trim()
      if (before !== '30 100' || after !== '40 120')
        throw new Error(`before=${before} after=${after}`)
      if (mainShell.processRef.pid !== mainShell.pid)
        throw new Error('stable process PID changed after resize')
      return `before=${before} after=${after} pid=${mainShell.pid} unchanged=true`
    })

    await record('state-persist', async () => {
      const subdir = join(tempRoot, 'persisted-cwd')
      const { mkdirSync } = await import('node:fs')
      mkdirSync(subdir)
      await frame(mainShell, `cd ${shellQuote(subdir)} && export FOO=bar`)
      const output = await frame(mainShell, `pwd; printf 'FOO=%s\\n' "$FOO"`)
      if (!output.includes(subdir) || !output.includes('FOO=bar')) {
        throw new Error(`state did not persist: ${JSON.stringify(output)}`)
      }
      return `cwd=${subdir} FOO=bar across separate writes`
    })

    await record('utf8', async () => {
      if (!(mainShell.collector instanceof TextCollector)) throw new Error('unexpected collector')
      const unit = '终端测试🙂'
      const expected = unit.repeat(2_000)
      const beforeChunks = mainShell.collector.chunks
      const output = await frame(mainShell, `printf '终端测试🙂%.0s' {1..2000}`, 8_000)
      if (output.includes('\uFFFD')) throw new Error('output contains U+FFFD')
      if (output !== expected) {
        throw new Error(
          `UTF-8 mismatch expectedBytes=${Buffer.byteLength(expected)} actualBytes=${Buffer.byteLength(output)}`
        )
      }
      return `bytes=${Buffer.byteLength(expected)} chunks=${mainShell.collector.chunks - beforeChunks} replacement=false codePointSplit=${mainShell.collector.splitCodePoint}`
    })

    await record('interactive-read', async () => {
      if (!(mainShell.collector instanceof TextCollector)) throw new Error('unexpected collector')
      const start = uniqueSentinel('READ_START')
      const end = uniqueSentinel('READ_END')
      const offset = mainShell.collector.text.length
      mainShell.pty.write(
        `stty -echo; ${emitSentinel(start)}; printf '\\n'; read -r x; printf 'got:%s\\n' "$x"; ${emitSentinel(end)}; printf '\\n'; stty echo\n`
      )
      const startAt = await mainShell.collector.waitFor(start, NORMAL_TIMEOUT_MS, offset)
      mainShell.pty.write('interactive-value\n')
      const endAt = await mainShell.collector.waitFor(
        end,
        NORMAL_TIMEOUT_MS,
        startAt + start.length
      )
      const output = normalizeTerminalText(
        mainShell.collector.text.slice(startAt + start.length, endAt)
      )
      if (!output.includes('got:interactive-value'))
        throw new Error(`read output=${JSON.stringify(output)}`)
      return 'separate input line returned got:interactive-value'
    })

    await record('ctrl-c', async () => {
      const interruptShell = await startShell(tempRoot, env)
      handles.push(interruptShell)
      if (!(interruptShell.collector instanceof TextCollector))
        throw new Error('unexpected collector')
      const started = uniqueSentinel('SLEEP_STARTED')
      const recovered = uniqueSentinel('SLEEP_RECOVERED')
      const offset = interruptShell.collector.text.length
      interruptShell.pty.write(
        `stty -echo; ${emitSentinel(started)}; printf '\\n'; /bin/sleep 30\n`
      )
      await interruptShell.collector.waitFor(started, NORMAL_TIMEOUT_MS, offset)
      await waitUntil(
        () => interruptShell.processRef.children().length > 0,
        500,
        'foreground sleep discovery'
      )
      const foreground = interruptShell.processRef.children()[0]
      const interruptedAt = performance.now()
      interruptShell.pty.write('\x03')
      await waitUntil(
        () => foreground.status() === ProcessStatus.Exited,
        500,
        'foreground sleep interrupt'
      )
      interruptShell.pty.write(`stty echo; ${emitSentinel(recovered)}; printf '\\n'\n`)
      await interruptShell.collector.waitFor(recovered, 1_000, offset)
      const elapsed = performance.now() - interruptedAt
      if (elapsed > 1_000) throw new Error(`recovery took ${elapsed.toFixed(1)}ms`)
      if (interruptShell.processRef.status() !== ProcessStatus.Running) {
        throw new Error('shell exited after Ctrl+C')
      }
      interruptShell.pty.write('exit 0\n')
      await withTimeout(interruptShell.exitPromise, NORMAL_TIMEOUT_MS, 'Ctrl+C shell exit')
      interruptShell.closed = true
      return `recoveredMs=${elapsed.toFixed(1)} shellAlive=true pid=${interruptShell.pid}`
    })

    await record('flood-ctrl-c', async () => {
      const collector = new FloodCollector()
      const handle = await startShell(tempRoot, env, collector)
      handles.push(handle)
      const rssBefore = process.memoryUsage().rss
      const startedAt = performance.now()
      handle.pty.write('/usr/bin/yes PHI_FLOOD\n')
      await waitUntil(() => collector.totalBytes >= 64 * 1024, 1_000, 'flood output start')
      const remaining = 3_000 - (performance.now() - startedAt)
      if (remaining > 0) await delay(remaining)
      const interruptAt = performance.now()
      const quietPromise = collector.waitForQuiet(300, 1_000)
      handle.pty.write('\x03')
      const stoppedMs = await quietPromise
      const elapsedSeconds = (interruptAt - startedAt) / 1_000
      const rssGrowth = process.memoryUsage().rss - rssBefore
      if (stoppedMs > 1_000)
        throw new Error(`output stop latency ${stoppedMs.toFixed(1)}ms exceeds 1s`)
      if (rssGrowth > 200 * 1024 * 1024) {
        throw new Error(`RSS growth ${(rssGrowth / 1024 / 1024).toFixed(1)}MiB exceeds 200MiB`)
      }
      await closeHandle(handle)
      return `stopMs=${stoppedMs.toFixed(1)} chunksPerSec=${(collector.chunks / elapsedSeconds).toFixed(0)} totalMiB=${(collector.totalBytes / 1024 / 1024).toFixed(1)} retainedMiB=${(collector.retainedBytes / 1024 / 1024).toFixed(1)} droppedMiB=${(collector.droppedBytes / 1024 / 1024).toFixed(1)} rssGrowthMiB=${(rssGrowth / 1024 / 1024).toFixed(1)}`
    })

    results.push({
      status: 'INFO',
      id: 'no-pause',
      evidence: cleanEvidence(
        `PtySession methods=${Object.getOwnPropertyNames(PtySession.prototype).join(',')}; always drain onChunk into 2MiB replay ring and emit a gap marker when oldest bytes are dropped`
      )
    })

    await record('exit', async () => {
      mainShell.pty.write('exit 7\n')
      const exit = await withTimeout(mainShell.exitPromise, NORMAL_TIMEOUT_MS, 'exit 7 result')
      mainShell.closed = true
      if (exit.exitCode !== 7) throw new Error(`PtyRunResult=${JSON.stringify(exit)}`)
      return `PtyRunResult=${JSON.stringify(exit)} keys=${Object.keys(exit).sort().join(',')}`
    })

    await record('close-graceful', async () => {
      const killOnly = await startShell(tempRoot, env)
      handles.push(killOnly)
      const killChildren = await prepareLongRunningChildren(killOnly, { background: true })
      killOnly.pty.kill()
      await withTimeout(
        killOnly.exitPromise.catch(() => undefined),
        1_000,
        'PtySession.kill exit'
      )
      killOnly.closed = true
      await delay(300)
      const killLeft = killChildren.filter((child) => child.status() === ProcessStatus.Running)
      await Promise.all(
        killLeft.map((child) =>
          child.terminate({ group: true, gracefulMs: -1, timeoutMs: 1_000 }).catch(() => false)
        )
      )

      const graceful = await startShell(tempRoot, env)
      handles.push(graceful)
      const childRefs = await prepareLongRunningChildren(graceful, { background: true })
      const refs = [graceful.processRef, ...childRefs]
      const startedAt = performance.now()
      const terminated = await graceful.processRef.terminate({
        group: true,
        gracefulMs: 2_000,
        timeoutMs: 5_000
      })
      await waitUntil(() => allExited(refs), 5_000, 'graceful process-tree exit')
      const elapsed = performance.now() - startedAt
      graceful.closed = true
      await withTimeout(
        graceful.exitPromise.catch(() => undefined),
        1_000,
        'graceful PTY exit'
      )
      return `killAloneLeft=${killLeft.length}/${killChildren.length} terminateResult=${terminated} tracked=${refs.length} gone=true elapsedMs=${elapsed.toFixed(1)}`
    })

    await record('close-quit-budget', async () => {
      const quitHandles = await Promise.all([0, 1, 2].map(() => startShell(tempRoot, env)))
      handles.push(...quitHandles)
      const childGroups = await Promise.all(
        quitHandles.map((handle) => prepareLongRunningChildren(handle, { background: false }))
      )
      const refs = quitHandles.flatMap((handle, index) => [
        handle.processRef,
        ...childGroups[index]
      ])
      const startedAt = performance.now()
      await Promise.all(
        quitHandles.map((handle) =>
          handle.processRef.terminate({ group: true, gracefulMs: 900, timeoutMs: 400 })
        )
      )
      await waitUntil(() => allExited(refs), 1_500, 'parallel quit cleanup')
      const elapsed = performance.now() - startedAt
      for (const handle of quitHandles) {
        handle.closed = true
        await withTimeout(
          handle.exitPromise.catch(() => undefined),
          500,
          'quit PTY exit'
        )
      }
      if (elapsed > 1_500) throw new Error(`parallel cleanup took ${elapsed.toFixed(1)}ms`)
      return `shells=3 tracked=${refs.length} elapsedMs=${elapsed.toFixed(1)} budgetMs=1500`
    })

    try {
      const job = await startShell(tempRoot, env)
      handles.push(job)
      const childRefs = await prepareLongRunningChildren(job, {
        background: false,
        jobControl: true
      })
      const child = childRefs[0]
      const shellGroup = job.processRef.groupId()
      const childGroup = child?.groupId() ?? null
      await job.processRef.terminate({ group: true, gracefulMs: 200, timeoutMs: 800 })
      await waitUntil(() => allExited([job.processRef, ...childRefs]), 1_500, 'job-control cleanup')
      job.closed = true
      await withTimeout(
        job.exitPromise.catch(() => undefined),
        500,
        'job-control PTY exit'
      )
      results.push({
        status: 'INFO',
        id: 'job-control-group',
        evidence: cleanEvidence(
          `shellGroup=${shellGroup} childGroup=${childGroup} separate=${shellGroup !== childGroup} groupTerminateReachedChild=${allExited(childRefs)}`
        )
      })
    } catch (error) {
      results.push({
        status: 'INFO',
        id: 'job-control-group',
        evidence: cleanEvidence(`unproven: ${error instanceof Error ? error.message : error}`)
      })
    }

    await record('worker-crash', async () => {
      const control = await startShell(tempRoot, env)
      handles.push(control)
      const script = fileURLToPath(import.meta.url)
      const worker = spawn(process.execPath, [script, '--worker-crash-child', tempRoot], {
        cwd: resolve('.'),
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let stdout = ''
      let stderr = ''
      worker.stdout.setEncoding('utf8')
      worker.stderr.setEncoding('utf8')
      worker.stdout.on('data', (chunk: string) => {
        stdout += chunk
      })
      worker.stderr.on('data', (chunk: string) => {
        stderr += chunk
      })
      await waitUntil(
        () => stdout.includes('"type":"started"'),
        NORMAL_TIMEOUT_MS,
        'crash worker start'
      )
      const startedLine = stdout.split('\n').find((line) => line.includes('"type":"started"'))
      if (!startedLine) throw new Error('worker did not report shell PID')
      const started = JSON.parse(startedLine) as { pid: number }
      const supervised = Process.fromPid(started.pid)
      if (!supervised) throw new Error(`supervisor could not register shell ${started.pid}`)
      await waitUntil(
        () => stdout.includes('"type":"ready"'),
        NORMAL_TIMEOUT_MS,
        'crash worker child ready'
      )
      const supervisedChildren = descendants(supervised)
      if (supervisedChildren.length === 0)
        throw new Error('supervised foreground child was not discoverable')
      const workerExit = new Promise<void>((resolveExit, rejectExit) => {
        worker.once('exit', () => resolveExit())
        worker.once('error', rejectExit)
      })
      const detectedAt = performance.now()
      worker.kill('SIGKILL')
      await withTimeout(workerExit, 2_000, 'worker SIGKILL')
      const ownDeadline = performance.now() + 300
      while (performance.now() < ownDeadline && supervised.status() === ProcessStatus.Running)
        await delay(10)
      const diedOnMasterClose = supervised.status() === ProcessStatus.Exited
      const ownDeathMs = diedOnMasterClose ? performance.now() - detectedAt : undefined
      const rootTerminateResult = await supervised.terminate({
        group: true,
        gracefulMs: 1_000,
        timeoutMs: 2_000
      })
      const rootRefReachedChildren = allExited(supervisedChildren)
      const remainingRefs = [supervised, ...supervisedChildren].filter(
        (processRef) => processRef.status() === ProcessStatus.Running
      )
      await Promise.all(
        remainingRefs.map((processRef) =>
          processRef.terminate({ group: true, gracefulMs: 1_000, timeoutMs: 2_000 })
        )
      )
      await waitUntil(
        () => allExited([supervised, ...supervisedChildren]),
        Math.max(1, 5_000 - (performance.now() - detectedAt)),
        'supervisor crash cleanup'
      )
      const cleanupMs = performance.now() - detectedAt
      const unregisteredAlive = control.processRef.status() === ProcessStatus.Running
      control.pty.write('exit 0\n')
      await withTimeout(control.exitPromise, NORMAL_TIMEOUT_MS, 'unregistered control exit')
      control.closed = true
      if (!unregisteredAlive)
        throw new Error('unregistered control shell was affected by supervisor cleanup')
      if (cleanupMs > 5_000) throw new Error(`supervisor cleanup took ${cleanupMs.toFixed(1)}ms`)
      if (stderr.trim()) throw new Error(`worker stderr=${stderr.trim()}`)
      return `registeredPid=${started.pid} childRefs=${supervisedChildren.length} cleanupMs=${cleanupMs.toFixed(1)} masterCloseAutoExit=${diedOnMasterClose}${ownDeathMs === undefined ? '' : ` autoExitMs=${ownDeathMs.toFixed(1)}`} rootTerminateResult=${rootTerminateResult} rootRefReachedChildren=${rootRefReachedChildren} retainedChildFallback=${remainingRefs.length} unregisteredPid=${control.pid} remainedAlive=true signalledOnlyRegistered=true`
    })

    const resourceDirs = findResourceDirectories(resolve('dist'))
    const packageVersion = JSON.parse(
      readFileSync(resolve('node_modules/@oh-my-pi/pi-natives/package.json'), 'utf8')
    ) as { version: string; engines?: { bun?: string } }
    if (resourceDirs.length === 0) {
      results.push({
        status: 'INFO',
        id: 'packaging',
        evidence: cleanEvidence(
          `no unpacked app found; pi-natives=${packageVersion.version} bun=${process.versions.bun ?? 'unknown'} requires=${packageVersion.engines?.bun ?? 'unknown'}; run build:unpack then rerun`
        )
      })
    } else {
      const resources = resourceDirs[0]
      const unpacked = join(resources, 'app.asar.unpacked')
      const workerPath = join(unpacked, 'out/main/terminal/terminal-worker.ts')
      const wrapperPath = join(unpacked, 'node_modules/@oh-my-pi/pi-natives/native/index.js')
      const binaryPath = join(
        unpacked,
        'node_modules/@oh-my-pi/pi-natives-darwin-arm64/pi_natives.darwin-arm64.node'
      )
      const present = (path: string): boolean => {
        try {
          accessSync(path)
          return true
        } catch {
          return false
        }
      }
      results.push({
        status:
          present(workerPath) && present(wrapperPath) && present(binaryPath) ? 'PASS' : 'INFO',
        id: 'packaging',
        evidence: cleanEvidence(
          `resources=${resources} worker=${present(workerPath)} wrapper=${present(wrapperPath)} nativeBinary=${present(binaryPath)}; current config cannot run an unpacked Bun terminal worker unless all three are unpacked; pin direct @oh-my-pi/pi-natives=${packageVersion.version}`
        )
      })
    }
  } catch (error) {
    const message = cleanEvidence(error instanceof Error ? error.message : error)
    for (const id of [
      'env-semantics',
      'login-path',
      'tty',
      'stty-size',
      'state-persist',
      'utf8',
      'interactive-read',
      'ctrl-c',
      'flood-ctrl-c',
      'exit',
      'close-graceful',
      'close-quit-budget',
      'worker-crash'
    ]) {
      if (!results.some((result) => result.id === id))
        results.push({ status: 'FAIL', id, evidence: message })
    }
    if (!results.some((result) => result.id === 'no-pause')) {
      results.push({
        status: 'INFO',
        id: 'no-pause',
        evidence: 'public API inspection still shows no pause/resume'
      })
    }
    if (!results.some((result) => result.id === 'job-control-group')) {
      results.push({ status: 'INFO', id: 'job-control-group', evidence: `unproven: ${message}` })
    }
    if (!results.some((result) => result.id === 'packaging')) {
      results.push({ status: 'INFO', id: 'packaging', evidence: `unproven: ${message}` })
    }
  } finally {
    await Promise.all(handles.map((handle) => closeHandle(handle)))
    rmSync(tempRoot, { recursive: true, force: true })
    if (originalLeak === undefined) delete process.env.PHI_SPIKE_LEAK
    else process.env.PHI_SPIKE_LEAK = originalLeak
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir
  }

  const order = [
    'env-semantics',
    'login-path',
    'tty',
    'stty-size',
    'state-persist',
    'utf8',
    'interactive-read',
    'ctrl-c',
    'flood-ctrl-c',
    'no-pause',
    'exit',
    'close-graceful',
    'close-quit-budget',
    'job-control-group',
    'worker-crash',
    'packaging'
  ]
  results.sort((left, right) => order.indexOf(left.id) - order.indexOf(right.id))
  for (const result of results) console.log(`${result.status} ${result.id} ${result.evidence}`)
  return results.some((result) => result.status === 'FAIL' && REQUIRED_IDS.has(result.id)) ? 1 : 0
}

if (process.argv[2] === '--worker-crash-child') {
  await runCrashWorkerChild(process.argv[3] ?? process.cwd())
} else {
  process.exitCode = await main()
}
