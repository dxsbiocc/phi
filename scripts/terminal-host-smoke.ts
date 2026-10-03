import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Process, ProcessStatus } from '@oh-my-pi/pi-natives'
import { buildTerminalEnv } from '../src/main/terminal/terminal-env'
import {
  TerminalHost,
  type TerminalChildSpawner,
  type TerminalCreateOptions,
  type TerminalHostEvent
} from '../src/main/terminal/terminal-host'
import { TERMINAL_CREDIT_WINDOW_BYTES } from '../src/shared/terminalTypes'

const NORMAL_TIMEOUT_MS = 5_000

type Result = { status: 'PASS' | 'FAIL'; id: string; evidence: string }

class OutputCollector {
  text = ''

  push(value: string): void {
    this.text += value
  }

  async waitForMatch(
    expression: RegExp,
    timeoutMs = NORMAL_TIMEOUT_MS,
    from = 0
  ): Promise<{ index: number; value: string }> {
    const deadline = Date.now() + timeoutMs
    while (true) {
      const match = expression.exec(this.text.slice(from))
      if (match) return { index: from + match.index, value: match[0] }
      if (Date.now() >= deadline) throw new Error(`timed out waiting for ${expression.source}`)
      await delay(10)
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

function terminalId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 16)}`
}

function marker(prefix: string): string {
  return `PHI_${prefix}_${randomUUID().replaceAll('-', '')}`
}

function normalize(value: string): string {
  return value.replaceAll('\r', '')
}

function childEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG'] as const) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

function isExited(processRef: Process): boolean {
  return processRef.status() === ProcessStatus.Exited
}

async function waitForExit(processRefs: Process[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!processRefs.every(isExited)) {
    if (Date.now() >= deadline) {
      throw new Error(
        `processes still alive: ${processRefs
          .filter((ref) => !isExited(ref))
          .map((ref) => ref.pid)
          .join(',')}`
      )
    }
    await delay(20)
  }
}

function requireProcess(pid: number): Process {
  const processRef = Process.fromPid(pid)
  if (!processRef) throw new Error(`could not retain process ${pid}`)
  return processRef
}

function shellOptions(id: string, cwd: string): TerminalCreateOptions {
  return {
    terminalId: id,
    application: '/bin/zsh',
    args: ['-il'],
    cwd,
    env: buildTerminalEnv(process.env),
    cols: 100,
    rows: 30
  }
}

async function frameCommand(
  host: TerminalHost,
  collector: OutputCollector,
  id: string,
  command: string,
  timeoutMs = NORMAL_TIMEOUT_MS
): Promise<string> {
  const start = marker('START')
  const end = marker('END')
  const offset = await disableEcho(host, collector, id)
  await host.input(
    id,
    `/usr/bin/printf '\\n${start}\\n'; ${command}; stty echo; /usr/bin/printf '\\n${end}\\n'\n`
  )
  const startLine = await collector.waitForMatch(
    new RegExp(`\\r?\\n${start}\\r?\\n`),
    timeoutMs,
    offset
  )
  const contentAt = startLine.index + startLine.value.length
  const endLine = await collector.waitForMatch(
    new RegExp(`\\r?\\n${end}\\r?\\n`),
    timeoutMs,
    contentAt
  )
  return normalize(collector.text.slice(contentAt, endLine.index)).trim()
}

async function disableEcho(
  host: TerminalHost,
  collector: OutputCollector,
  id: string
): Promise<number> {
  const ready = marker('NOECHO')
  const offset = collector.text.length
  await host.input(id, `unsetopt zle; stty -echo; /usr/bin/printf '\\n${ready}\\n'\n`)
  const readyLine = await collector.waitForMatch(
    new RegExp(`\\r?\\n${ready}\\r?\\n`),
    NORMAL_TIMEOUT_MS,
    offset
  )
  return readyLine.index + readyLine.value.length
}

async function prepareIgnoringChild(
  host: TerminalHost,
  collector: OutputCollector,
  id: string
): Promise<Process> {
  const childMarker = marker('CHILD')
  const offset = await disableEcho(host, collector, id)
  await host.input(
    id,
    `trap '' HUP; /bin/sleep 30 & child=$!; /usr/bin/printf '${childMarker}:%s\\n' "$child"; stty echo; wait "$child"\n`
  )
  const childLine = await collector.waitForMatch(
    new RegExp(`\\r?\\n${childMarker}:(\\d+)\\r?\\n`),
    NORMAL_TIMEOUT_MS,
    offset
  )
  const pid = Number(childLine.value.match(new RegExp(`${childMarker}:(\\d+)`))?.[1])
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('failed to capture child PID')
  return requireProcess(pid)
}

async function main(): Promise<number> {
  const results: Result[] = []
  const tempRoot = mkdtempSync(join(tmpdir(), 'phi-terminal-host-'))
  const collectors = new Map<string, OutputCollector>()
  const workerChildren: ChildProcessWithoutNullStreams[] = []
  const workerPath = resolve('src/main/terminal/terminal-worker.ts')
  const supervisorPath = resolve('src/main/terminal/terminal-supervisor.ts')
  const spawnReal: TerminalChildSpawner = (scriptPath) => {
    const child = spawn('bun', [scriptPath], {
      cwd: process.cwd(),
      env: childEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe']
    })
    if (scriptPath.endsWith('terminal-worker.ts')) workerChildren.push(child)
    return child
  }

  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = '/tmp/phi-terminal-host-smoke-secret'
  const host = new TerminalHost({
    spawnWorker: spawnReal,
    spawnSupervisor: spawnReal,
    workerPath,
    supervisorPath
  })
  host.subscribe((event: TerminalHostEvent) => {
    if (event.type === 'data') collectors.get(event.terminalId)?.push(event.data)
  })

  const record = async (id: string, check: () => Promise<string>): Promise<void> => {
    try {
      results.push({ status: 'PASS', id, evidence: await check() })
    } catch (error) {
      results.push({
        status: 'FAIL',
        id,
        evidence: error instanceof Error ? error.message : String(error)
      })
    }
  }

  const create = async (
    prefix: string
  ): Promise<{
    id: string
    pid: number
    collector: OutputCollector
  }> => {
    const id = terminalId(prefix)
    const collector = new OutputCollector()
    collectors.set(id, collector)
    const started = await host.createTerminal(shellOptions(id, tempRoot))
    await host.credit(id, TERMINAL_CREDIT_WINDOW_BYTES)
    return { id, pid: started.pid, collector }
  }

  try {
    await record('shell-credit-resize-env-ctrl-c', async () => {
      const shell = await create('basic')
      const echoed = await frameCommand(
        host,
        shell.collector,
        shell.id,
        "/usr/bin/printf 'ECHO_OK'"
      )
      if (!echoed.includes('ECHO_OK')) throw new Error(`echo output=${JSON.stringify(echoed)}`)

      await host.resize(shell.id, 111, 41)
      const size = await frameCommand(host, shell.collector, shell.id, 'stty size')
      if (!size.includes('41 111')) throw new Error(`stty size=${JSON.stringify(size)}`)

      const environment = await frameCommand(
        host,
        shell.collector,
        shell.id,
        "/usr/bin/env | /usr/bin/grep -q '^PI_CODING_AGENT_DIR=' && echo LEAK || echo CLEAN"
      )
      if (!environment.includes('CLEAN') || environment.includes('LEAK')) {
        throw new Error(`environment evidence=${JSON.stringify(environment)}`)
      }

      await host.input(shell.id, '/bin/sleep 30\n')
      await delay(200)
      const interruptedAt = performance.now()
      await host.input(shell.id, '\x03')
      const recovered = await frameCommand(
        host,
        shell.collector,
        shell.id,
        "/usr/bin/printf 'RECOVERED'",
        1_000
      )
      if (!recovered.includes('RECOVERED')) throw new Error('shell did not recover after Ctrl+C')
      const recoveryMs = performance.now() - interruptedAt
      await host.close(shell.id, 'user')
      return `echo=true size=41x111 envClean=true ctrlCRecoveryMs=${recoveryMs.toFixed(1)}`
    })

    await record('user-close-hup-ignoring-child', async () => {
      const shell = await create('close')
      const root = requireProcess(shell.pid)
      const child = await prepareIgnoringChild(host, shell.collector, shell.id)
      await delay(1_100)
      const startedAt = performance.now()
      await host.close(shell.id, 'user')
      await waitForExit([root, child], NORMAL_TIMEOUT_MS)
      const elapsedMs = performance.now() - startedAt
      if (elapsedMs > NORMAL_TIMEOUT_MS) throw new Error(`close took ${elapsedMs.toFixed(1)}ms`)
      return `root=${root.pid} child=${child.pid} elapsedMs=${elapsedMs.toFixed(1)}`
    })

    await record('worker-crash-supervisor-cleanup', async () => {
      const shell = await create('crash')
      const root = requireProcess(shell.pid)
      const child = await prepareIgnoringChild(host, shell.collector, shell.id)
      await delay(1_100)
      const worker = workerChildren.at(-1)
      if (!worker) throw new Error('worker child was not captured')
      const startedAt = performance.now()
      worker.kill('SIGKILL')
      await waitForExit([root, child], NORMAL_TIMEOUT_MS)
      const elapsedMs = performance.now() - startedAt
      return `root=${root.pid} child=${child.pid} elapsedMs=${elapsedMs.toFixed(1)}`
    })

    await record('quit-close-all-budget', async () => {
      const shells = await Promise.all([create('quit1'), create('quit2'), create('quit3')])
      const roots = shells.map((shell) => requireProcess(shell.pid))
      const children = await Promise.all(
        shells.map((shell) => prepareIgnoringChild(host, shell.collector, shell.id))
      )
      await delay(1_100)
      const startedAt = performance.now()
      await host.closeAll('quit')
      const elapsedMs = performance.now() - startedAt
      if (elapsedMs > 1_500) throw new Error(`closeAll took ${elapsedMs.toFixed(1)}ms`)
      await waitForExit([...roots, ...children], 500)
      return `shells=3 elapsedMs=${elapsedMs.toFixed(1)} allExited=true`
    })
  } finally {
    await host.dispose()
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir
    rmSync(tempRoot, { recursive: true, force: true })
  }

  for (const result of results) {
    process.stdout.write(`${result.status} ${result.id} ${result.evidence}\n`)
  }
  return results.every((result) => result.status === 'PASS') ? 0 : 1
}

process.exitCode = await main()
