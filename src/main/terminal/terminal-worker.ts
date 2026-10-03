import { PtySession, type PtyRunResult } from '@oh-my-pi/pi-natives'

import { TerminalOutputBuffer } from './terminal-output-buffer'
import { parseWorkerRequest, type WorkerRequest } from './terminal-protocol'
import { createProtocolRequestStream } from './terminal-protocol-stream'

const START_TIMEOUT_MS = 10_000

type SessionState = 'pending' | 'started' | 'exited' | 'failed'

type TerminalSession = {
  terminalId: string
  pty: PtySession
  output: TerminalOutputBuffer
  pid: number | null
  state: SessionState
  exitPromise: Promise<PtyRunResult> | null
  disposeOnExit: boolean
}

const sessions = new Map<string, TerminalSession>()

const protocol = createProtocolRequestStream<WorkerRequest>({
  name: 'terminal-worker',
  fallbackErrorMessage: 'Terminal operation failed',
  parseRequest: parseWorkerRequest
})
const { diagnostic, errorMessage, writeFrame } = protocol

function emitError(terminalId: string, message: string): void {
  writeFrame({ type: 'error', terminalId, message })
}

function startedSession(terminalId: string): TerminalSession {
  const session = sessions.get(terminalId)
  if (!session || session.state !== 'started') {
    throw new Error(`Terminal ${terminalId} is not open`)
  }
  return session
}

function knownSession(terminalId: string): TerminalSession {
  const session = sessions.get(terminalId)
  if (!session) throw new Error(`Terminal ${terminalId} is not available`)
  return session
}

function removeSession(session: TerminalSession): void {
  if (sessions.get(session.terminalId) === session) sessions.delete(session.terminalId)
  session.output.dispose()
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
        timeoutMs
      )
    })
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function monitorExit(
  session: TerminalSession,
  exitPromise: Promise<PtyRunResult>,
  rejectStarted: (error: Error) => void
): void {
  void exitPromise
    .then((result) => {
      if (sessions.get(session.terminalId) !== session) return
      if (session.state === 'pending') {
        session.state = 'failed'
        rejectStarted(new Error('PTY exited before reporting its process id'))
        removeSession(session)
        return
      }
      session.output.flush()
      if (session.state === 'started') {
        writeFrame({
          type: 'exit',
          terminalId: session.terminalId,
          exitCode: result.exitCode ?? null,
          cancelled: result.cancelled,
          timedOut: result.timedOut
        })
      }
      session.state = 'exited'
      if (session.disposeOnExit) removeSession(session)
    })
    .catch((error: unknown) => {
      if (sessions.get(session.terminalId) !== session) return
      if (session.state === 'pending') {
        session.state = 'failed'
        rejectStarted(error instanceof Error ? error : new Error(errorMessage(error)))
        removeSession(session)
        return
      }
      if (session.state === 'started') {
        emitError(session.terminalId, errorMessage(error))
      }
      session.state = 'failed'
      if (session.disposeOnExit) removeSession(session)
    })
}

async function createTerminal(
  request: Extract<WorkerRequest, { type: 'create' }>
): Promise<{ pid: number }> {
  if (sessions.has(request.terminalId)) {
    throw new Error(`Terminal ${request.terminalId} already exists`)
  }

  const pty = new PtySession()
  const terminalId = request.terminalId
  const output = new TerminalOutputBuffer({
    onData: (record) => writeFrame({ type: 'data', terminalId, ...record }),
    onGap: (gap) => writeFrame({ type: 'gap', terminalId, ...gap })
  })
  const session: TerminalSession = {
    terminalId,
    pty,
    output,
    pid: null,
    state: 'pending',
    exitPromise: null,
    disposeOnExit: false
  }
  sessions.set(terminalId, session)

  let resolveStarted!: (pid: number) => void
  let rejectStarted!: (error: Error) => void
  const started = new Promise<number>((resolve, reject) => {
    resolveStarted = resolve
    rejectStarted = reject
  })

  try {
    const exitPromise = pty.startArgv(
      {
        application: request.application,
        args: request.args,
        cwd: request.cwd,
        env: request.env,
        cols: request.cols,
        rows: request.rows
      },
      (error, chunk) => {
        if (sessions.get(terminalId) !== session) return
        if (error) emitError(terminalId, errorMessage(error))
        if (chunk) output.push(chunk)
      },
      (error, pid) => {
        if (session.state !== 'pending') return
        if (error) {
          session.state = 'failed'
          rejectStarted(error)
          return
        }
        session.pid = pid
        session.state = 'started'
        writeFrame({ type: 'started', terminalId, pid })
        resolveStarted(pid)
      }
    )
    session.exitPromise = exitPromise
    monitorExit(session, exitPromise, rejectStarted)

    const pid = await withTimeout(started, START_TIMEOUT_MS, `Terminal ${terminalId} start`)
    return { pid }
  } catch (error) {
    if (session.state === 'pending') session.state = 'failed'
    try {
      pty.kill()
    } catch {
      diagnostic('PTY cleanup failed after a start error')
    }
    removeSession(session)
    emitError(terminalId, errorMessage(error))
    throw error
  }
}

async function handleRequest(request: WorkerRequest): Promise<unknown> {
  switch (request.type) {
    case 'create':
      return await createTerminal(request)
    case 'input':
      startedSession(request.terminalId).pty.write(request.data)
      return null
    case 'resize':
      startedSession(request.terminalId).pty.resize(request.cols, request.rows)
      return null
    case 'kill': {
      const session = sessions.get(request.terminalId)
      if (!session) return { killed: false }
      session.disposeOnExit = true
      if (session.state === 'started' || session.state === 'pending') session.pty.kill()
      else removeSession(session)
      return { killed: true }
    }
    case 'credit':
      knownSession(request.terminalId).output.addCredit(request.bytes)
      return null
    case 'setCredit':
      knownSession(request.terminalId).output.setCredit(request.bytes)
      return null
    case 'replay':
      return knownSession(request.terminalId).output.replay(request.fromSeq)
    case 'ping':
      return { pong: true }
  }
}

function shutdownAfterHostExit(): void {
  for (const session of sessions.values()) session.output.dispose()
  sessions.clear()
  process.exit(0)
}

protocol.start(handleRequest)
process.stdin.once('end', shutdownAfterHostExit)
process.stdin.once('error', () => shutdownAfterHostExit())
process.stdout.once('error', shutdownAfterHostExit)
