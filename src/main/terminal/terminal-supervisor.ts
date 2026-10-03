import { Process, ProcessStatus, type ProcessTerminateOptions } from '@oh-my-pi/pi-natives'

import {
  TERMINAL_MAX_FRAME_BYTES,
  encodeProtocolFrame,
  parseProtocolLine,
  parseSupervisorRequest,
  type SupervisorRequest,
  type SupervisorResponse
} from './terminal-protocol'

const REFRESH_INTERVAL_MS = 1_000
const QUIT_EXIT_DEADLINE_MS = 1_500

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

function writeFrame(frame: SupervisorResponse): void {
  process.stdout.write(encodeProtocolFrame(frame))
}

function diagnostic(message: string): void {
  process.stderr.write(`[terminal-supervisor] ${message}\n`)
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return (message || 'Supervisor operation failed').slice(0, 4_096)
}

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
  mode: 'user' | 'quit'
): Promise<TerminationResult> {
  refreshDescendants(entry)
  if (mode === 'quit') {
    const options = { group: true, gracefulMs: 900, timeoutMs: 400 } as const
    await Promise.all(entryReferences(entry).map((processRef) => terminateRef(processRef, options)))
    return terminationResult([entry])
  }

  await terminateRef(entry.root, { group: true, gracefulMs: 2_000, timeoutMs: 5_000 })
  const remainingDescendants = [...entry.descendants.values()].filter(isRunning)
  await Promise.all(
    remainingDescendants.map((processRef) =>
      terminateRef(processRef, { group: true, gracefulMs: 0, timeoutMs: 5_000 })
    )
  )
  return terminationResult([entry])
}

async function terminateAll(mode: 'user' | 'quit'): Promise<TerminationResult> {
  const entries = [...managed.values()]
  await Promise.all(entries.map((entry) => terminateEntry(entry, mode)))
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

async function processLine(line: string): Promise<void> {
  let request: SupervisorRequest
  try {
    request = parseSupervisorRequest(parseProtocolLine(line))
  } catch {
    diagnostic('discarded an invalid protocol frame')
    return
  }

  try {
    const result = await handleRequest(request)
    writeFrame({ id: request.id, ok: true, result })
  } catch (error) {
    writeFrame({ id: request.id, ok: false, error: errorMessage(error) })
  }
}

function acceptProtocolInput(onLine: (line: string) => void): void {
  let buffered = Buffer.alloc(0)
  let discarding = false

  process.stdin.on('data', (value: Buffer | string) => {
    const chunk = typeof value === 'string' ? Buffer.from(value) : value
    let offset = 0
    while (offset < chunk.byteLength) {
      const newline = chunk.indexOf(10, offset)
      const end = newline < 0 ? chunk.byteLength : newline
      const segment = chunk.subarray(offset, end)

      if (!discarding) {
        if (buffered.byteLength + segment.byteLength > TERMINAL_MAX_FRAME_BYTES) {
          buffered = Buffer.alloc(0)
          discarding = newline < 0
          diagnostic('discarded an oversized protocol frame')
        } else {
          buffered = Buffer.concat([buffered, segment])
          if (newline >= 0) {
            const lineBuffer = buffered.at(-1) === 13 ? buffered.subarray(0, -1) : buffered
            onLine(lineBuffer.toString('utf8'))
            buffered = Buffer.alloc(0)
          }
        }
      } else if (newline >= 0) {
        discarding = false
      }

      if (newline < 0) break
      offset = newline + 1
    }
  })
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

acceptProtocolInput((line) => {
  void processLine(line).catch(() => diagnostic('request processing failed'))
})
process.stdin.once('end', () => void shutdownAfterHostExit())
process.stdin.once('error', () => void shutdownAfterHostExit())
process.stdout.once('error', () => void shutdownAfterHostExit())
