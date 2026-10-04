import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import type { TerminalEvent } from '../src/shared/terminalTypes'
import { TerminalDraftService } from '../src/main/terminal/terminal-command-draft'
import { TerminalHost, type TerminalChildSpawner } from '../src/main/terminal/terminal-host'
import { TerminalManager } from '../src/main/terminal/terminal-manager'
import { resolveTerminalWorkspace } from '../src/main/terminal/terminal-workspace'

if (process.platform !== 'darwin') {
  process.stdout.write('SKIP terminal manager smoke requires macOS\n')
  process.exit(0)
}

const workspace = mkdtempSync(join(tmpdir(), 'phi-terminal-manager-'))
const workspaceRealPath = realpathSync(workspace)
const pidFile = join(workspace, 'shell.pid')
const childPidFile = join(workspace, 'child.pid')
const draftMarkerFile = join(workspace, 'draft-marker')
const recordsByEpoch = new Map<number, Array<{ seq: number; data: string }>>()
const hostChildren: ChildProcessWithoutNullStreams[] = []
let manager: TerminalManager | undefined
let draftService: TerminalDraftService | undefined
let ackChain = Promise.resolve()

function waitFor(check: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const poll = (): void => {
      if (check()) return resolve()
      if (Date.now() >= deadline) return reject(new Error(`${label} timed out`))
      setTimeout(poll, 10)
    }
    poll()
  })
}

function epochRecords(epoch: number): Array<{ seq: number; data: string }> {
  const records = recordsByEpoch.get(epoch) ?? []
  recordsByEpoch.set(epoch, records)
  return records
}

function epochText(epoch: number): string {
  return [...epochRecords(epoch)]
    .sort((left, right) => left.seq - right.seq)
    .map((record) => record.data)
    .join('')
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function hostChildEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG'] as const) {
    if (process.env[key] !== undefined) environment[key] = process.env[key]
  }
  return environment
}

function receive(event: TerminalEvent): void {
  if (event.type !== 'data') return
  epochRecords(event.epoch).push({ seq: event.seq, data: event.data })
  const bytes = Buffer.byteLength(event.data, 'utf8')
  const activeManager = manager
  if (!activeManager) return
  ackChain = ackChain.then(() => activeManager.ack(event.terminalId, event.epoch, bytes))
}

try {
  const spawnHostChild: TerminalChildSpawner = (scriptPath) => {
    const child = spawn('bun', [scriptPath], {
      cwd: process.cwd(),
      env: hostChildEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe']
    })
    hostChildren.push(child)
    return child
  }
  const host = new TerminalHost({
    spawnWorker: spawnHostChild,
    spawnSupervisor: spawnHostChild,
    workerPath: resolve('src/main/terminal/terminal-worker.ts'),
    supervisorPath: resolve('src/main/terminal/terminal-supervisor.ts')
  })
  manager = new TerminalManager({
    resolveWorkspace: (ref) =>
      resolveTerminalWorkspace(ref, {
        getProject: (projectId) =>
          projectId === 'smoke'
            ? {
                name: 'Terminal smoke',
                location: {
                  kind: 'local',
                  path: workspace,
                  realPath: workspaceRealPath
                }
              }
            : undefined,
        noProjectTaskFolder: () => workspace,
        realDirectory: (path) => (path === workspace ? workspaceRealPath : null),
        isRemoteAnchor: () => false
      }),
    sink: receive,
    hostFactory: () => host
  })

  const terminal = await manager.create(
    { kind: 'project', projectId: 'smoke' },
    100,
    30,
    'manager_smoke_create'
  )
  assert.equal(terminal.initialCwd, workspaceRealPath)

  const firstAttach = await manager.attach(terminal.terminalId)
  epochRecords(firstAttach.epoch).push(...firstAttach.records)
  const replayBytes = firstAttach.records.reduce(
    (total, record) => total + Buffer.byteLength(record.data, 'utf8'),
    0
  )
  if (replayBytes > 0) await manager.ack(terminal.terminalId, firstAttach.epoch, replayBytes)

  draftService = new TerminalDraftService({
    manager,
    randomDraftId: () => 'draft_smoke',
    createSession: async () => {
      let assistantText = ''
      return {
        prompt: async () => {
          assistantText = JSON.stringify({
            command: 'touch <marker>',
            explanation: 'Create the requested marker file.',
            requiredInputs: [{ name: 'marker', description: 'Marker file path' }]
          })
        },
        assistantText: () => assistantText,
        abort: async () => undefined,
        dispose: async () => undefined
      }
    }
  })
  const generatedDraft = await draftService.generate({
    requestId: 'draft_generate_smoke',
    terminalId: terminal.terminalId,
    kind: 'command',
    request: 'Create a marker file'
  })
  assert.equal(existsSync(draftMarkerFile), false)
  await draftService.submit({
    requestId: 'draft_submit_smoke',
    draftId: generatedDraft.draftId,
    source: `touch '${draftMarkerFile.replaceAll("'", "'\\''")}'`,
    bracketedPaste: false
  })
  await waitFor(() => existsSync(draftMarkerFile), 2_000, 'draft marker file')

  await manager.input(
    terminal.terminalId,
    `printf '%s\\n' "$$" > '${pidFile.replaceAll("'", "'\\''")}'\n`
  )
  await manager.input(terminal.terminalId, "printf 'MANAGER_ECHO_OK\\n'\n")
  await waitFor(() => epochText(firstAttach.epoch).includes('MANAGER_ECHO_OK'), 5_000, 'echo')
  await waitFor(() => existsSync(pidFile), 2_000, 'shell pid file')
  const shellPid = Number(readFileSync(pidFile, 'utf8').trim())
  assert.ok(Number.isSafeInteger(shellPid) && shellPid > 0)
  await manager.input(
    terminal.terminalId,
    `trap '' HUP; /bin/sleep 30 & child=$!; printf '%s\\n' "$child" > '${childPidFile.replaceAll("'", "'\\''")}'\n`
  )
  await waitFor(() => existsSync(childPidFile), 2_000, 'child pid file')
  const childPid = Number(readFileSync(childPidFile, 'utf8').trim())
  assert.ok(Number.isSafeInteger(childPid) && childPid > 0)
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_100))

  await manager.input(
    terminal.terminalId,
    'i=1; while [ $i -le 100 ]; do printf \'REATTACH:%03d\\n\' "$i"; i=$((i+1)); sleep 0.005; done\n'
  )
  await waitFor(
    () => epochText(firstAttach.epoch).includes('REATTACH:010'),
    5_000,
    'pre-reattach output'
  )

  const secondAttach = await manager.attach(terminal.terminalId)
  epochRecords(secondAttach.epoch).push(...secondAttach.records)
  const secondReplayBytes = secondAttach.records.reduce(
    (total, record) => total + Buffer.byteLength(record.data, 'utf8'),
    0
  )
  if (secondReplayBytes > 0) {
    await manager.ack(terminal.terminalId, secondAttach.epoch, secondReplayBytes)
  }
  await waitFor(
    () => epochText(secondAttach.epoch).includes('REATTACH:100'),
    5_000,
    'post-reattach output'
  )
  await ackChain

  const reattached = [...epochRecords(secondAttach.epoch)].sort(
    (left, right) => left.seq - right.seq
  )
  assert.equal(new Set(reattached.map((record) => record.seq)).size, reattached.length)
  for (let index = 1; index < reattached.length; index += 1) {
    assert.equal(reattached[index].seq, reattached[index - 1].seq + 1)
  }
  const markers = [...epochText(secondAttach.epoch).matchAll(/REATTACH:(\d{3})/gu)].map((match) =>
    Number(match[1])
  )
  assert.deepEqual(
    markers,
    Array.from({ length: 100 }, (_, index) => index + 1)
  )

  await manager.input(terminal.terminalId, 'yes PHI_TERMINAL_FLOOD\n')
  const floodStartSeq = reattached.at(-1)?.seq ?? 0
  await waitFor(
    () => epochRecords(secondAttach.epoch).some((record) => record.seq > floodStartSeq),
    3_000,
    'flood output'
  )
  const interruptedAt = performance.now()
  await manager.input(terminal.terminalId, '\u0003')
  await manager.input(terminal.terminalId, "printf 'AFTER_CTRL_C\\n'\n")
  await waitFor(
    () => epochText(secondAttach.epoch).includes('AFTER_CTRL_C'),
    1_000,
    'Ctrl+C recovery'
  )
  const interruptElapsedMs = performance.now() - interruptedAt
  assert.ok(interruptElapsedMs <= 1_000)

  const disposeStartedAt = performance.now()
  await manager.dispose()
  const disposeElapsedMs = performance.now() - disposeStartedAt
  assert.ok(disposeElapsedMs <= 1_500)
  await waitFor(() => !running(shellPid), 1_000, 'shell cleanup')
  await waitFor(() => !running(childPid), 1_000, 'child cleanup')
  const hostPids = hostChildren.flatMap((child) => (child.pid ? [child.pid] : []))
  await waitFor(() => hostPids.every((pid) => !running(pid)), 1_000, 'host process cleanup')

  process.stdout.write(
    `PASS terminal-manager echo=true draftMarker=true reattachRecords=${reattached.length} ctrlCMs=${interruptElapsedMs.toFixed(1)} disposeMs=${disposeElapsedMs.toFixed(1)} shell=${shellPid} child=${childPid} hostProcesses=${hostPids.length} survivors=0\n`
  )
} finally {
  await draftService?.dispose().catch(() => undefined)
  await manager?.dispose().catch(() => undefined)
  rmSync(workspace, { recursive: true, force: true })
}
