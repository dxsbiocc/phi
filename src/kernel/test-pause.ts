import { closeSync, fsyncSync, openSync, writeSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export type KernelTestPausePoint = 'a' | 'c' | 'd1' | 'd2'

const scheduledPoints = new Set<KernelTestPausePoint>()

function hasCommittedToolResult(journal: string, toolCallId: string): boolean {
  return journal.split('\n').some((line) => {
    if (!line) return false
    try {
      const entry = JSON.parse(line) as { message?: Record<string, unknown> }
      return entry.message?.role === 'toolResult' && entry.message.toolCallId === toolCallId
    } catch {
      return false
    }
  })
}

function enabled(point: KernelTestPausePoint): boolean {
  return process.env.PHI_KERNEL_TEST_PAUSE === point
}

/**
 * Deterministic SIGKILL seam for process tests. Production never enters this path
 * unless the private test environment variable names this exact point.
 */
export function pauseKernelTestPoint(point: KernelTestPausePoint, agentDir: string): void {
  if (!enabled(point)) return
  const markerPath = join(agentDir, 'phi-kernel', `test-pause-${point}.marker`)
  const marker = openSync(markerPath, 'w', 0o600)
  try {
    writeSync(marker, `${process.pid}\n`)
    fsyncSync(marker)
  } finally {
    closeSync(marker)
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
}

/**
 * OMP notifies subscribers before its queued message-end append runs. For A05(c),
 * poll only in the opted-in test process and stop it once the exact tool result is
 * visible in the journal, then enter the synchronous kill window.
 */
export function pauseAfterJournalCommit(
  point: 'c',
  agentDir: string,
  journalPath: string,
  toolCallId: string
): void {
  if (!enabled(point) || scheduledPoints.has(point)) return
  scheduledPoints.add(point)
  const deadline = Date.now() + 10_000
  const check = async (): Promise<void> => {
    try {
      const journal = await readFile(journalPath, 'utf8')
      if (hasCommittedToolResult(journal, toolCallId)) {
        pauseKernelTestPoint(point, agentDir)
        return
      }
    } catch {
      // The test harness will time out if the journal never reaches the commit point.
    }
    if (Date.now() < deadline) setTimeout(() => void check(), 2)
  }
  setImmediate(() => void check())
}
