import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

import { Process, ProcessStatus } from '@oh-my-pi/pi-natives'

import { TerminalError } from '../src/main/terminal/terminal-error'
import { spawnBunProcess } from '../src/main/terminal/terminal-host-process'
import { TerminalHost, type TerminalChildSpawner } from '../src/main/terminal/terminal-host'
import { TerminalManager, type TerminalHostLike } from '../src/main/terminal/terminal-manager'
import { resolveTerminalWorkspace } from '../src/main/terminal/terminal-workspace'
import {
  TERMINAL_CREDIT_WINDOW_BYTES,
  TERMINAL_RING_BUFFER_BYTES,
  type TerminalEvent,
  type TerminalSnapshot,
  type TerminalState
} from '../src/shared/terminalTypes'

const FLOOD_DURATION_MS = 30_000
const NORMAL_TIMEOUT_MS = 5_000
const MIB = 1024 * 1024
// A 3-minute disconnected flood plateaus near +180 MiB (GC headroom for ~100 MB/s string churn), not linear growth.
const WORKER_RSS_GROWTH_LIMIT_BYTES = 320 * MIB
const MAIN_HEAP_GROWTH_LIMIT_BYTES = 128 * MIB
const ACK_BATCH_BYTES = 32 * 1024
const ACK_BATCH_DELAY_MS = 16

type StreamStats = {
  events: number
  bytes: number
  lastDataAt: number
  tail: string
}

type SequenceToken = { type: 'data'; seq: number } | { type: 'gap'; fromSeq: number; toSeq: number }

type CapturedChild = {
  kind: 'worker' | 'supervisor'
  child: ChildProcessWithoutNullStreams
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

async function waitFor(check: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (!check()) {
    if (performance.now() >= deadline) throw new Error(`${label} timed out after ${timeoutMs}ms`)
    await delay(10)
  }
}

async function waitForQuiet(
  stats: StreamStats,
  quietMs: number,
  timeoutMs: number,
  label: string
): Promise<void> {
  const deadline = performance.now() + timeoutMs
  let lastEvents = stats.events
  let quietSince = performance.now()
  while (performance.now() - quietSince < quietMs) {
    if (performance.now() >= deadline) throw new Error(`${label} did not become quiet`)
    await delay(10)
    if (stats.events !== lastEvents) {
      lastEvents = stats.events
      quietSince = performance.now()
    }
  }
}

function requestId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 16)}`
}

function marker(prefix: string): string {
  return `PHI_${prefix}_${randomUUID().replaceAll('-', '')}`
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function mib(value: number): string {
  return (value / MIB).toFixed(1)
}

function replayBytes(records: ReadonlyArray<{ data: string }>): number {
  return records.reduce((total, record) => total + Buffer.byteLength(record.data, 'utf8'), 0)
}

function createWorkerRssReader(): { read(pid: number): number; close(): void } {
  const { dlopen, FFIType, ptr } = createRequire(import.meta.url)('bun:ffi') as {
    dlopen(
      path: string,
      symbols: Record<string, unknown>
    ): {
      symbols: {
        proc_pidinfo(
          pid: number,
          flavor: number,
          arg: number,
          buffer: unknown,
          bufferSize: number
        ): number
      }
      close(): void
    }
    FFIType: { i32: unknown; u64: unknown; ptr: unknown }
    ptr(buffer: Buffer): unknown
  }
  const library = dlopen('/usr/lib/libproc.dylib', {
    proc_pidinfo: {
      args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32],
      returns: FFIType.i32
    }
  })
  return {
    read: (pid) => {
      // PROC_PIDTASKINFO returns proc_taskinfo; resident_size is its second uint64 field.
      const taskInfo = Buffer.alloc(96)
      const bytes = library.symbols.proc_pidinfo(pid, 4, 0, ptr(taskInfo), taskInfo.byteLength)
      if (bytes !== taskInfo.byteLength) {
        throw new Error(`proc_pidinfo returned ${bytes} bytes for worker ${pid}`)
      }
      return Number(taskInfo.readBigUInt64LE(8))
    },
    close: () => library.close()
  }
}

function readPid(path: string): number {
  const pid = Number(readFileSync(path, 'utf8').trim())
  assert.ok(Number.isSafeInteger(pid) && pid > 0, `invalid PID in ${path}`)
  return pid
}

function requireProcess(pid: number): Process {
  const processRef = Process.fromPid(pid)
  assert.ok(processRef, `could not retain process ${pid}`)
  return processRef
}

function exited(processRef: Process): boolean {
  try {
    return processRef.status() === ProcessStatus.Exited
  } catch {
    return false
  }
}

class EventProbe {
  readonly states = new Map<string, TerminalState>()
  private readonly streams = new Map<string, StreamStats>()
  private readonly watchedMarkers = new Map<string, number | undefined>()
  private readonly capturedEpochs = new Set<string>()
  private readonly sequences = new Map<string, SequenceToken[]>()

  record(event: TerminalEvent): void {
    if (event.type === 'state') {
      this.states.set(event.snapshot.terminalId, event.snapshot.state)
      return
    }

    const key = this.key(event.terminalId, event.epoch)
    if (event.type === 'gap') {
      if (this.capturedEpochs.has(key)) {
        this.sequenceTokens(event.terminalId, event.epoch).push({
          type: 'gap',
          fromSeq: event.fromSeq,
          toSeq: event.toSeq
        })
      }
      return
    }

    const stats = this.stats(event.terminalId, event.epoch)
    stats.events += 1
    stats.bytes += Buffer.byteLength(event.data, 'utf8')
    stats.lastDataAt = performance.now()
    if (this.capturedEpochs.has(key)) {
      this.sequenceTokens(event.terminalId, event.epoch).push({ type: 'data', seq: event.seq })
    }

    for (const [sentinel, foundAt] of this.watchedMarkers) {
      if (foundAt !== undefined) continue
      const boundary = `${stats.tail}${event.data.slice(0, sentinel.length)}`
      if (event.data.includes(sentinel) || boundary.includes(sentinel)) {
        this.watchedMarkers.set(sentinel, performance.now())
      }
    }
    stats.tail = `${stats.tail}${event.data}`.slice(-256)
  }

  stats(terminalId: string, epoch: number): StreamStats {
    const key = this.key(terminalId, epoch)
    let stats = this.streams.get(key)
    if (!stats) {
      stats = { events: 0, bytes: 0, lastDataAt: 0, tail: '' }
      this.streams.set(key, stats)
    }
    return stats
  }

  capture(terminalId: string, epoch: number): void {
    this.capturedEpochs.add(this.key(terminalId, epoch))
  }

  sequenceTokens(terminalId: string, epoch: number): SequenceToken[] {
    const key = this.key(terminalId, epoch)
    let tokens = this.sequences.get(key)
    if (!tokens) {
      tokens = []
      this.sequences.set(key, tokens)
    }
    return tokens
  }

  watch(sentinel: string): void {
    this.watchedMarkers.set(sentinel, undefined)
  }

  markerAt(sentinel: string): number | undefined {
    return this.watchedMarkers.get(sentinel)
  }

  private key(terminalId: string, epoch: number): string {
    return `${terminalId}:${epoch}`
  }
}

class BatchedAcker {
  private readonly enabled = new Set<string>()
  private readonly batches = new Map<
    string,
    { terminalId: string; epoch: number; bytes: number; timer?: NodeJS.Timeout }
  >()
  private readonly inFlight = new Set<Promise<void>>()
  readonly errors: string[] = []

  constructor(private readonly manager: () => TerminalManager | undefined) {}

  enable(terminalId: string, epoch: number): void {
    this.enabled.add(this.key(terminalId, epoch))
  }

  record(event: TerminalEvent): void {
    if (event.type !== 'data') return
    const key = this.key(event.terminalId, event.epoch)
    if (!this.enabled.has(key)) return
    let batch = this.batches.get(key)
    if (!batch) {
      batch = { terminalId: event.terminalId, epoch: event.epoch, bytes: 0 }
      this.batches.set(key, batch)
    }
    batch.bytes += Buffer.byteLength(event.data, 'utf8')
    if (batch.bytes >= ACK_BATCH_BYTES) this.flush(key)
    else batch.timer ??= setTimeout(() => this.flush(key), ACK_BATCH_DELAY_MS)
  }

  disableTerminal(terminalId: string): void {
    for (const key of [...this.enabled]) {
      if (key.startsWith(`${terminalId}:`)) this.enabled.delete(key)
    }
    for (const [key, batch] of [...this.batches]) {
      if (batch.terminalId !== terminalId) continue
      if (batch.timer) clearTimeout(batch.timer)
      this.batches.delete(key)
    }
  }

  async settle(): Promise<void> {
    for (const key of [...this.batches.keys()]) this.flush(key)
    await Promise.all([...this.inFlight])
  }

  dispose(): void {
    this.enabled.clear()
    for (const batch of this.batches.values()) {
      if (batch.timer) clearTimeout(batch.timer)
    }
    this.batches.clear()
  }

  private flush(key: string): void {
    const batch = this.batches.get(key)
    if (!batch) return
    if (batch.timer) clearTimeout(batch.timer)
    this.batches.delete(key)
    if (!this.enabled.has(key) || batch.bytes <= 0) return
    const manager = this.manager()
    if (!manager) return
    const request = manager
      .ack(batch.terminalId, batch.epoch, batch.bytes)
      .catch((error: unknown) => {
        this.errors.push(error instanceof Error ? error.message : String(error))
      })
      .finally(() => this.inFlight.delete(request))
    this.inFlight.add(request)
  }

  private key(terminalId: string, epoch: number): string {
    return `${terminalId}:${epoch}`
  }
}

function validateContinuity(
  records: ReadonlyArray<{ seq: number }>,
  gap: { toSeq: number } | undefined,
  tokens: ReadonlyArray<SequenceToken>
): number {
  assert.ok(records.length > 0, 'reattach replay was empty')
  let expected = gap ? gap.toSeq + 1 : records[0].seq
  const seen = new Set<number>()
  for (const record of records) {
    assert.equal(record.seq, expected, `replay sequence jumped at ${record.seq}`)
    assert.equal(seen.has(record.seq), false, `duplicate replay sequence ${record.seq}`)
    seen.add(record.seq)
    expected += 1
  }
  for (const token of tokens) {
    if (token.type === 'gap') {
      assert.equal(
        token.fromSeq,
        expected,
        `live gap began at ${token.fromSeq}, expected ${expected}`
      )
      assert.ok(token.toSeq >= token.fromSeq)
      expected = token.toSeq + 1
      continue
    }
    assert.equal(token.seq, expected, `live sequence jumped at ${token.seq}`)
    assert.equal(seen.has(token.seq), false, `duplicate live sequence ${token.seq}`)
    seen.add(token.seq)
    expected += 1
  }
  return seen.size
}

async function main(): Promise<void> {
  if (process.platform !== 'darwin') {
    process.stdout.write('SKIP terminal stress smoke requires macOS\n')
    return
  }

  const workspace = mkdtempSync(join(tmpdir(), 'phi-terminal-stress-'))
  const rssReader = createWorkerRssReader()
  const workspaceRealPath = realpathSync(workspace)
  const disconnectedFloodPidFile = join(workspace, 'disconnected-flood.pid')
  const crashShellPidFile = join(workspace, 'crash-shell.pid')
  const crashChildPidFile = join(workspace, 'crash-child.pid')
  const recoveredShellPidFile = join(workspace, 'recovered-shell.pid')
  const children: CapturedChild[] = []
  const trackedProcesses: Process[] = []
  const bunExecutables = new Set<string>()
  const unhandledRejections: string[] = []
  const onUnhandledRejection = (reason: unknown): void => {
    unhandledRejections.push(reason instanceof Error ? reason.message : String(reason))
  }
  process.on('unhandledRejection', onUnhandledRejection)

  let manager: TerminalManager | undefined
  const probe = new EventProbe()
  const acker = new BatchedAcker(() => manager)
  const workerPath = resolve('src/main/terminal/terminal-worker.ts')
  const supervisorPath = resolve('src/main/terminal/terminal-supervisor.ts')
  const spawnCaptured: TerminalChildSpawner = (scriptPath) => {
    const child = spawnBunProcess(scriptPath)
    assert.equal(isAbsolute(child.spawnfile), true, `Bun path is not absolute: ${child.spawnfile}`)
    bunExecutables.add(child.spawnfile)
    const kind = scriptPath === workerPath ? 'worker' : 'supervisor'
    children.push({ kind, child })
    return child
  }
  let hostCreditCalls = 0
  const createManager = (countCredits: boolean): TerminalManager => {
    const host = new TerminalHost({
      spawnWorker: spawnCaptured,
      spawnSupervisor: spawnCaptured,
      workerPath,
      supervisorPath
    })
    const managedHost: TerminalHostLike = countCredits
      ? {
          subscribe: (listener) => host.subscribe(listener),
          createTerminal: (options) => host.createTerminal(options),
          input: (terminalId, data) => host.input(terminalId, data),
          resize: (terminalId, cols, rows) => host.resize(terminalId, cols, rows),
          credit: (terminalId, bytes) => {
            hostCreditCalls += 1
            return host.credit(terminalId, bytes)
          },
          setCredit: (terminalId, bytes) => host.setCredit(terminalId, bytes),
          replay: (terminalId, fromSeq) => host.replay(terminalId, fromSeq),
          close: (terminalId, mode) => host.close(terminalId, mode),
          dispose: () => host.dispose()
        }
      : host
    return new TerminalManager({
      resolveWorkspace: (ref) =>
        resolveTerminalWorkspace(ref, {
          getProject: (projectId) =>
            projectId === 'stress'
              ? {
                  name: 'Terminal stress smoke',
                  location: { kind: 'local', path: workspace, realPath: workspaceRealPath }
                }
              : undefined,
          noProjectTaskFolder: () => workspace,
          realDirectory: (path) => (path === workspace ? workspaceRealPath : null),
          isRemoteAnchor: () => false
        }),
      sink: (event) => {
        probe.record(event)
        acker.record(event)
      },
      hostFactory: () => managedHost
    })
  }

  const latestChild = (kind: CapturedChild['kind']): ChildProcessWithoutNullStreams => {
    const child = [...children]
      .reverse()
      .find((entry) => entry.kind === kind && entry.child.exitCode === null)?.child
    assert.ok(child?.pid, `active ${kind} child was not captured`)
    return child
  }

  const create = async (prefix: string): Promise<TerminalSnapshot> => {
    assert.ok(manager)
    return await manager.create(
      { kind: 'project', projectId: 'stress' },
      100,
      30,
      requestId(prefix)
    )
  }

  const attachWithAcks = async (terminalId: string): Promise<number> => {
    assert.ok(manager)
    const attachment = await manager.attach(terminalId)
    const stats = probe.stats(terminalId, attachment.epoch)
    const alreadyDeliveredBytes = stats.bytes
    acker.enable(terminalId, attachment.epoch)
    const initialBytes = replayBytes(attachment.records) + alreadyDeliveredBytes
    if (initialBytes > 0) await manager.ack(terminalId, attachment.epoch, initialBytes)
    attachment.records.length = 0
    return attachment.epoch
  }

  try {
    manager = createManager(true)

    const disconnected = await create('stress_disconnected')
    const firstAttach = await manager.attach(disconnected.terminalId)
    const firstReplayBytes = replayBytes(firstAttach.records)
    if (firstReplayBytes > 0) {
      await manager.ack(disconnected.terminalId, firstAttach.epoch, firstReplayBytes)
    }
    firstAttach.records.length = 0
    const firstStats = probe.stats(disconnected.terminalId, firstAttach.epoch)
    const startEvents = firstStats.events
    const startBytes = firstStats.bytes
    const worker = latestChild('worker')
    const workerPid = worker.pid as number
    const workerRssStart = rssReader.read(workerPid)
    const heapStart = process.memoryUsage().heapUsed
    let workerRssPeak = workerRssStart
    let heapPeak = heapStart
    const memorySampler = setInterval(() => {
      try {
        workerRssPeak = Math.max(workerRssPeak, rssReader.read(workerPid))
        heapPeak = Math.max(heapPeak, process.memoryUsage().heapUsed)
      } catch {
        // The worker staying alive is asserted by all subsequent phase operations.
      }
    }, 250)

    const disconnectedStartedAt = performance.now()
    let disconnectedFlood: Process | undefined
    try {
      await manager.input(
        disconnected.terminalId,
        `/usr/bin/yes PHI_NO_ACK_FLOOD & flood=$!; /bin/echo "$flood" > ${shellQuote(disconnectedFloodPidFile)}\n`
      )
      await waitFor(() => firstStats.events > startEvents, 1_000, 'disconnected flood output')
      await waitFor(
        () => existsSync(disconnectedFloodPidFile),
        NORMAL_TIMEOUT_MS,
        'disconnected flood PID file'
      )
      disconnectedFlood = requireProcess(readPid(disconnectedFloodPidFile))
      trackedProcesses.push(disconnectedFlood)
      const plateauSampleDelay = Math.max(
        0,
        FLOOD_DURATION_MS - 5_000 - (performance.now() - disconnectedStartedAt)
      )
      await delay(plateauSampleDelay)
      const plateauEvents = firstStats.events
      const remaining = Math.max(0, FLOOD_DURATION_MS - (performance.now() - disconnectedStartedAt))
      await delay(remaining)
      assert.equal(
        firstStats.events - plateauEvents,
        0,
        'protocol data traffic continued after the credit window was exhausted'
      )
    } finally {
      clearInterval(memorySampler)
      workerRssPeak = Math.max(workerRssPeak, rssReader.read(workerPid))
      heapPeak = Math.max(heapPeak, process.memoryUsage().heapUsed)
    }

    const disconnectedBytes = firstStats.bytes - startBytes
    const disconnectedEvents = firstStats.events - startEvents
    const workerRssGrowth = Math.max(0, workerRssPeak - workerRssStart)
    const heapGrowth = Math.max(0, heapPeak - heapStart)
    assert.ok(
      disconnectedBytes <= TERMINAL_CREDIT_WINDOW_BYTES,
      `no-ACK traffic exceeded credit: ${disconnectedBytes}`
    )
    assert.ok(
      workerRssGrowth <= WORKER_RSS_GROWTH_LIMIT_BYTES,
      `worker RSS grew ${mib(workerRssGrowth)} MiB (limit ${mib(WORKER_RSS_GROWTH_LIMIT_BYTES)} MiB)`
    )
    assert.ok(
      heapGrowth <= MAIN_HEAP_GROWTH_LIMIT_BYTES,
      `main heap grew ${mib(heapGrowth)} MiB (limit ${mib(MAIN_HEAP_GROWTH_LIMIT_BYTES)} MiB)`
    )

    assert.ok(disconnectedFlood, 'disconnected flood process was not retained')
    const floodStopStartedAt = performance.now()
    disconnectedFlood.killTree(2)
    await waitFor(() => exited(disconnectedFlood), NORMAL_TIMEOUT_MS, 'disconnected flood exit')
    const floodExitedAt = performance.now()
    const floodStopMs = floodExitedAt - floodStopStartedAt

    const expectedSecondEpoch = firstAttach.epoch + 1
    probe.capture(disconnected.terminalId, expectedSecondEpoch)
    const secondAttach = await manager.attach(disconnected.terminalId)
    assert.equal(secondAttach.epoch, expectedSecondEpoch)
    assert.ok(secondAttach.gap, 'reattach did not report a dropped-output gap')
    const secondReplayBytes = replayBytes(secondAttach.records)
    assert.ok(
      secondReplayBytes <= TERMINAL_RING_BUFFER_BYTES,
      `replay exceeded ring bound: ${secondReplayBytes}`
    )
    const secondStats = probe.stats(disconnected.terminalId, secondAttach.epoch)
    await waitForQuiet(secondStats, 300, 3_000, 'second attachment')
    const creditCallsBeforeStaleAck = hostCreditCalls
    await manager.ack(disconnected.terminalId, firstAttach.epoch, TERMINAL_CREDIT_WINDOW_BYTES)
    assert.equal(
      hostCreditCalls,
      creditCallsBeforeStaleAck,
      'stale old-epoch ACK reached the real host credit path'
    )

    const currentOutstanding = secondReplayBytes + secondStats.bytes
    assert.ok(currentOutstanding > 0, 'current attachment had no acknowledgeable output')
    const validAckBytes = Math.min(TERMINAL_CREDIT_WINDOW_BYTES, currentOutstanding)
    await manager.ack(disconnected.terminalId, secondAttach.epoch, validAckBytes)
    assert.equal(
      hostCreditCalls,
      creditCallsBeforeStaleAck + 1,
      'current-epoch ACK did not reach the real host credit path exactly once'
    )
    const secondEpochTokens = probe.sequenceTokens(disconnected.terminalId, secondAttach.epoch)
    let acknowledgedSecondEpochBytes = validAckBytes
    for (let pass = 0; pass < 8; pass += 1) {
      const deliveredBytes = secondReplayBytes + secondStats.bytes
      while (acknowledgedSecondEpochBytes < deliveredBytes) {
        const grant = Math.min(ACK_BATCH_BYTES, deliveredBytes - acknowledgedSecondEpochBytes)
        await manager.ack(disconnected.terminalId, secondAttach.epoch, grant)
        acknowledgedSecondEpochBytes += grant
      }
      await delay(20)
    }
    acker.enable(disconnected.terminalId, secondAttach.epoch)
    const liveSentinel = marker('REATTACH_LIVE')
    const liveSentinelSplit = Math.floor(liveSentinel.length / 2)
    probe.watch(liveSentinel)
    const liveSentAt = performance.now()
    await manager.input(
      disconnected.terminalId,
      `/usr/bin/printf '%s%s\\n' ${shellQuote(liveSentinel.slice(0, liveSentinelSplit))} ${shellQuote(liveSentinel.slice(liveSentinelSplit))}\n`
    )
    await waitFor(
      () => probe.markerAt(liveSentinel) !== undefined,
      30_000,
      'live sentinel after replay drain'
    )
    await waitForQuiet(secondStats, 150, 1_500, 'reattach output drain')
    await acker.settle()
    acker.disableTerminal(disconnected.terminalId)
    assert.ok(
      secondEpochTokens.some((token) => token.type === 'data'),
      'reattach continuity did not include live data'
    )
    const drainToLiveMs = (probe.markerAt(liveSentinel) as number) - floodExitedAt
    const liveSentinelMs = (probe.markerAt(liveSentinel) as number) - liveSentAt
    const contiguousSequences = validateContinuity(
      secondAttach.records,
      secondAttach.gap,
      secondEpochTokens
    )
    secondAttach.records.length = 0
    await manager.close(disconnected.terminalId)

    process.stdout.write(
      `PASS terminal-stress-disconnected durationMs=${FLOOD_DURATION_MS} dataEvents=${disconnectedEvents} protocolBytes=${disconnectedBytes} plateauTailEvents=0 workerPid=${workerPid} workerRssStartMiB=${mib(workerRssStart)} workerRssPeakMiB=${mib(workerRssPeak)} workerRssGrowthMiB=${mib(workerRssGrowth)} workerRssLimitMiB=${mib(WORKER_RSS_GROWTH_LIMIT_BYTES)} mainHeapStartMiB=${mib(heapStart)} mainHeapPeakMiB=${mib(heapPeak)} mainHeapGrowthMiB=${mib(heapGrowth)} mainHeapLimitMiB=${mib(MAIN_HEAP_GROWTH_LIMIT_BYTES)}\n`
    )
    process.stdout.write(
      `PASS terminal-stress-reattach gap=${secondAttach.gap.fromSeq}-${secondAttach.gap.toSeq} droppedBytes=${secondAttach.gap.droppedBytes} replayBytes=${secondReplayBytes} replayLimitBytes=${TERMINAL_RING_BUFFER_BYTES} sequences=${contiguousSequences} staleAckHostCreditCalls=0 validAckBytes=${validAckBytes} currentAckHostCreditCalls=1 floodStopMs=${floodStopMs.toFixed(1)} acknowledgedBytes=${acknowledgedSecondEpochBytes} drainToLiveMs=${drainToLiveMs.toFixed(1)} liveSentinelMs=${liveSentinelMs.toFixed(1)}\n`
    )

    // The specification calls for a separate ACKed flood. Disposing here also prevents the
    // no-ACK worker's native output backlog from contaminating latency measurements.
    await manager.dispose()
    manager = createManager(false)

    const acknowledged = await create('stress_acknowledged')
    const acknowledgedEpoch = await attachWithAcks(acknowledged.terminalId)
    const acknowledgedStats = probe.stats(acknowledged.terminalId, acknowledgedEpoch)
    const noFlushReady = marker('ACK_NOFLSH')
    const noFlushReadySplit = Math.floor(noFlushReady.length / 2)
    probe.watch(noFlushReady)
    await manager.input(
      acknowledged.terminalId,
      `stty noflsh; /usr/bin/printf '%s%s\\n' ${shellQuote(noFlushReady.slice(0, noFlushReadySplit))} ${shellQuote(noFlushReady.slice(noFlushReadySplit))}\n`
    )
    await waitFor(() => probe.markerAt(noFlushReady) !== undefined, 1_000, 'stty noflsh readiness')
    const acknowledgedStartEvents = acknowledgedStats.events
    const acknowledgedStartedAt = performance.now()
    await manager.input(acknowledged.terminalId, '/usr/bin/yes PHI_ACK_FLOOD\n')
    await waitFor(
      () => acknowledgedStats.events > acknowledgedStartEvents,
      1_000,
      'ACK flood output'
    )
    await delay(Math.max(0, FLOOD_DURATION_MS / 2 - (performance.now() - acknowledgedStartedAt)))
    const queuedSentinel = marker('ACK_QUEUED')
    const queuedSentinelSplit = Math.floor(queuedSentinel.length / 2)
    const typedEchoSentinel = marker('ACK_TYPED')
    probe.watch(queuedSentinel)
    probe.watch(typedEchoSentinel)
    const typedAt = performance.now()
    await manager.input(
      acknowledged.terminalId,
      `/usr/bin/printf '%s%s\\n' ${shellQuote(queuedSentinel.slice(0, queuedSentinelSplit))} ${shellQuote(queuedSentinel.slice(queuedSentinelSplit))} # ${typedEchoSentinel}\n`
    )
    await waitFor(
      () => probe.markerAt(typedEchoSentinel) !== undefined,
      1_000,
      'typed input echo during ACK flood'
    )
    const typedEchoMs = (probe.markerAt(typedEchoSentinel) as number) - typedAt
    await delay(Math.max(0, FLOOD_DURATION_MS - (performance.now() - acknowledgedStartedAt)))
    assert.equal(
      probe.markerAt(queuedSentinel),
      undefined,
      'queued sentinel executed before Ctrl+C'
    )
    const interruptedAt = performance.now()
    await manager.input(acknowledged.terminalId, '\u0003')
    await waitFor(
      () => probe.markerAt(queuedSentinel) !== undefined,
      1_000,
      'queued post-Ctrl+C sentinel'
    )
    await waitForQuiet(acknowledgedStats, 150, 1_500, 'ACK flood after Ctrl+C')
    const queuedSentinelMs = (probe.markerAt(queuedSentinel) as number) - interruptedAt
    const outputStopMs = Math.max(0, acknowledgedStats.lastDataAt - interruptedAt)
    assert.ok(typedEchoMs <= 1_000, `typed sentinel echo latency was ${typedEchoMs.toFixed(1)}ms`)
    assert.ok(
      queuedSentinelMs <= 1_000,
      `queued post-Ctrl+C sentinel took ${queuedSentinelMs.toFixed(1)}ms`
    )
    assert.ok(outputStopMs <= 1_000, `flood output stop latency was ${outputStopMs.toFixed(1)}ms`)
    await acker.settle()
    assert.deepEqual(acker.errors, [], 'batched ACKs failed during the healthy flood')
    acker.disableTerminal(acknowledged.terminalId)
    await manager.close(acknowledged.terminalId)
    process.stdout.write(
      `PASS terminal-stress-acked durationMs=${FLOOD_DURATION_MS} midpointMs=${FLOOD_DURATION_MS / 2} dataEvents=${acknowledgedStats.events - acknowledgedStartEvents} protocolMiB=${mib(acknowledgedStats.bytes)} typedEchoMs=${typedEchoMs.toFixed(1)} queuedSentinelMs=${queuedSentinelMs.toFixed(1)} outputStopMs=${outputStopMs.toFixed(1)} ackBatchBytes=${ACK_BATCH_BYTES} ackBatchDelayMs=${ACK_BATCH_DELAY_MS}\n`
    )

    const crashing = await create('stress_worker_crash')
    const crashingEpoch = await attachWithAcks(crashing.terminalId)
    await manager.input(
      crashing.terminalId,
      `/usr/bin/printf '%s\\n' "$$" > ${shellQuote(crashShellPidFile)}; /bin/sh -c 'trap "" HUP; while :; do /bin/sleep 30; done' & child=$!; /usr/bin/printf '%s\\n' "$child" > ${shellQuote(crashChildPidFile)}; /usr/bin/yes PHI_CRASH_FLOOD\n`
    )
    await waitFor(
      () => existsSync(crashShellPidFile) && existsSync(crashChildPidFile),
      NORMAL_TIMEOUT_MS,
      'crash PID files'
    )
    const crashRoot = requireProcess(readPid(crashShellPidFile))
    const crashChild = requireProcess(readPid(crashChildPidFile))
    trackedProcesses.push(crashRoot, crashChild)
    await delay(1_200)
    acker.disableTerminal(crashing.terminalId)
    const crashingWorker = latestChild('worker')
    const crashStartedAt = performance.now()
    assert.equal(crashingWorker.kill('SIGKILL'), true, 'worker SIGKILL was not sent')
    await waitFor(
      () => probe.states.get(crashing.terminalId) === 'failed',
      NORMAL_TIMEOUT_MS,
      'failed state after worker SIGKILL'
    )
    await waitFor(
      () => exited(crashRoot) && exited(crashChild),
      NORMAL_TIMEOUT_MS,
      'supervisor cleanup after worker SIGKILL'
    )
    const crashCleanupMs = performance.now() - crashStartedAt
    assert.ok(crashCleanupMs <= NORMAL_TIMEOUT_MS)
    await delay(50)
    assert.deepEqual(
      unhandledRejections,
      [],
      'worker crash produced an unhandled manager rejection'
    )

    const recovered = await create('stress_after_worker_crash')
    const recoveredEpoch = await attachWithAcks(recovered.terminalId)
    const recoveredSentinel = marker('RECOVERED')
    probe.watch(recoveredSentinel)
    const recoveredSplit = Math.floor(recoveredSentinel.length / 2)
    await manager.input(
      recovered.terminalId,
      `/usr/bin/printf '%s%s\\n' ${shellQuote(recoveredSentinel.slice(0, recoveredSplit))} ${shellQuote(recoveredSentinel.slice(recoveredSplit))}; /usr/bin/printf '%s\\n' "$$" > ${shellQuote(recoveredShellPidFile)}\n`
    )
    await waitFor(
      () => probe.markerAt(recoveredSentinel) !== undefined && existsSync(recoveredShellPidFile),
      NORMAL_TIMEOUT_MS,
      'terminal creation after worker crash'
    )
    const recoveredRoot = requireProcess(readPid(recoveredShellPidFile))
    trackedProcesses.push(recoveredRoot)
    process.stdout.write(
      `PASS terminal-stress-worker-crash worker=${crashingWorker.pid} epoch=${crashingEpoch} shell=${crashRoot.pid} hupIgnoringChild=${crashChild.pid} cleanupMs=${crashCleanupMs.toFixed(1)} failedState=true unhandledRejections=0 recreatedTerminal=${recovered.terminalId} recreatedEpoch=${recoveredEpoch}\n`
    )

    await manager.input(recovered.terminalId, '/usr/bin/yes PHI_SUPERVISOR_FLOOD\n')
    const recoveredStats = probe.stats(recovered.terminalId, recoveredEpoch)
    await waitFor(() => recoveredStats.events > 0, 1_000, 'supervisor-fault flood output')
    const supervisor = latestChild('supervisor')
    acker.disableTerminal(recovered.terminalId)
    const supervisorKilledAt = performance.now()
    assert.equal(supervisor.kill('SIGKILL'), true, 'supervisor SIGKILL was not sent')
    await waitFor(
      () => probe.states.get(recovered.terminalId) === 'failed',
      NORMAL_TIMEOUT_MS,
      'failed state after supervisor SIGKILL'
    )
    await waitFor(() => exited(recoveredRoot), NORMAL_TIMEOUT_MS, 'worker PTY kill')
    const existingPtyKilledMs = performance.now() - supervisorKilledAt

    await assert.rejects(
      () => create('stress_after_supervisor_crash'),
      (error: unknown) =>
        error instanceof TerminalError &&
        error.code === 'unavailable' &&
        error.message === 'Terminal failed to start',
      'new terminal creation should be unavailable after supervisor death'
    )
    const disposeStartedAt = performance.now()
    await manager.dispose()
    const disposeMs = performance.now() - disposeStartedAt
    assert.ok(disposeMs <= 1_500, `manager.dispose took ${disposeMs.toFixed(1)}ms`)
    assert.deepEqual(unhandledRejections, [], 'supervisor crash produced an unhandled rejection')
    assert.equal(bunExecutables.size, 1, 'worker and supervisor did not use one resolved Bun')
    const bunExecutable = [...bunExecutables][0]
    assert.ok(isAbsolute(bunExecutable))
    process.stdout.write(
      `PASS terminal-stress-supervisor-crash supervisor=${supervisor.pid} existingPty=${recoveredRoot.pid} existingPtyKilledMs=${existingPtyKilledMs.toFixed(1)} createUnavailable=true disposeMs=${disposeMs.toFixed(1)} bun=${bunExecutable} absoluteBun=true\n`
    )
  } finally {
    acker.dispose()
    await manager?.dispose().catch(() => undefined)
    for (const processRef of trackedProcesses) {
      if (exited(processRef)) continue
      await processRef.terminate({ group: true, gracefulMs: 0, timeoutMs: 500 }).catch(() => false)
    }
    for (const { child } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
    await delay(50)
    process.removeListener('unhandledRejection', onUnhandledRejection)
    rssReader.close()
    rmSync(workspace, { recursive: true, force: true })
  }
}

await main()
