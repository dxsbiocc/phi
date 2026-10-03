import { Process, ProcessStatus, type ProcessTerminateOptions } from '@oh-my-pi/pi-natives'

import { parseSupervisorRequest, type SupervisorRequest } from './terminal-protocol'
import { createProtocolRequestStream } from './terminal-protocol-stream'

const REFRESH_INTERVAL_MS = 1_000
const QUIT_EXIT_DEADLINE_MS = 1_500
const USER_TERMINATION_DEADLINE_MS = 4_800
const QUIT_TERMINATION_DEADLINE_MS = 1_300

type ManagedProcess = {
  root: Process
  descendants: Map<number, Process>
}

type TerminationResult = {
  allExited: boolean
  survivors: number[]
}

const managed = new Map<string, ManagedProcess>()
let shuttingDown = false

const protocol = createProtocolRequestStream<SupervisorRequest>({
  name: 'terminal-supervisor',
  fallbackErrorMessage: 'Supervisor operation failed',
  parseRequest: parseSupervisorRequest
})
const { diagnostic } = protocol

function isRunning(processRef: Process): boolean {
  try {
    return processRef.status() === ProcessStatus.Running
  } catch {
    return true
  }
}

function refreshDescendants(entry: ManagedProcess): void {
  for (const [pid, processRef] of entry.descendants) {
    if (!isRunning(processRef)) entry.descendants.delete(pid)
  }
  if (!isRunning(entry.root)) return

  const visited = new Set<number>([entry.root.pid])
  const visit = (parent: Process): void => {
    let children: Process[]
    try {
      children = parent.children()
    } catch {
      return
    }
    for (const child of children) {
      if (visited.has(child.pid)) continue
      visited.add(child.pid)
      if (isRunning(child)) entry.descendants.set(child.pid, child)
      visit(child)
    }
  }
  visit(entry.root)
}

function entryReferences(entry: ManagedProcess): Process[] {
  return [entry.root, ...entry.descendants.values()]
}

function terminationResult(entries: ManagedProcess[]): TerminationResult {
  const survivors = new Set<number>()
  for (const entry of entries) {
    for (const processRef of entryReferences(entry)) {
      if (isRunning(processRef)) survivors.add(processRef.pid)
    }
  }
  return { allExited: survivors.size === 0, survivors: [...survivors].sort((a, b) => a - b) }
}

async function terminateRef(processRef: Process, options: ProcessTerminateOptions): Promise<void> {
  if (!isRunning(processRef)) return
  try {
    await processRef.terminate(options)
  } catch {
    diagnostic('a registered process did not acknowledge termination')
  }
}

async function terminateEntry(
  entry: ManagedProcess,
  mode: 'user' | 'quit',
  deadline = Date.now() +
    (mode === 'quit' ? QUIT_TERMINATION_DEADLINE_MS : USER_TERMINATION_DEADLINE_MS)
): Promise<TerminationResult> {
  refreshDescendants(entry)
  if (mode === 'quit') {
    const remaining = Math.max(1, deadline - Date.now())
    const gracefulMs = Math.min(900, Math.max(0, remaining - 1))
    const options = {
      group: true,
      gracefulMs,
      timeoutMs: Math.max(1, Math.min(400, remaining - gracefulMs))
    } as const
    await Promise.all(entryReferences(entry).map((processRef) => terminateRef(processRef, options)))
    return terminationResult([entry])
  }

  const rootRemaining = Math.max(1, deadline - Date.now())
  const rootGracefulMs = Math.min(2_000, Math.max(0, rootRemaining - 1))
  await terminateRef(entry.root, {
    group: true,
    gracefulMs: rootGracefulMs,
    timeoutMs: Math.max(1, rootRemaining - rootGracefulMs)
  })
  const remainingDescendants = [...entry.descendants.values()].filter(isRunning)
  const descendantTimeoutMs = Math.max(1, deadline - Date.now())
  await Promise.all(
    remainingDescendants.map((processRef) =>
      terminateRef(processRef, { group: true, gracefulMs: 0, timeoutMs: descendantTimeoutMs })
    )
  )
  return terminationResult([entry])
}

async function terminateAll(mode: 'user' | 'quit'): Promise<TerminationResult> {
  const entries = [...managed.values()]
  const deadline =
    Date.now() + (mode === 'quit' ? QUIT_TERMINATION_DEADLINE_MS : USER_TERMINATION_DEADLINE_MS)
  await Promise.all(entries.map((entry) => terminateEntry(entry, mode, deadline)))
  return terminationResult(entries)
}

async function handleRequest(request: SupervisorRequest): Promise<unknown> {
  switch (request.type) {
    case 'register': {
      if (managed.has(request.terminalId)) {
        throw new Error(`Terminal ${request.terminalId} is already registered`)
      }
      const root = Process.fromPid(request.pid)
      if (!root) throw new Error(`Process ${request.pid} could not be registered`)
      managed.set(request.terminalId, {
        root,
        descendants: new Map()
      })
      return { registered: true }
    }
    case 'terminate': {
      const entry = managed.get(request.terminalId)
      if (!entry) throw new Error(`Terminal ${request.terminalId} is not registered`)
      return await terminateEntry(entry, request.mode)
    }
    case 'terminateAll':
      return await terminateAll(request.mode)
    case 'forget':
      return { forgotten: managed.delete(request.terminalId) }
    case 'ping':
      return { pong: true }
  }
}

async function shutdownAfterHostExit(): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  clearInterval(refreshTimer)
  const forceExit = setTimeout(() => process.exit(1), QUIT_EXIT_DEADLINE_MS)
  try {
    await terminateAll('quit')
  } finally {
    clearTimeout(forceExit)
    process.exit(0)
  }
}

const refreshTimer = setInterval(() => {
  for (const entry of managed.values()) refreshDescendants(entry)
}, REFRESH_INTERVAL_MS)

protocol.start(handleRequest)
process.stdin.once('end', () => void shutdownAfterHostExit())
process.stdin.once('error', () => void shutdownAfterHostExit())
process.stdout.once('error', () => void shutdownAfterHostExit())
