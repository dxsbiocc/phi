#!/usr/bin/env bun
/**
 * Real-SDK no-cloud regression for the Cursor native piBash abort path.
 *
 * Run on the host with Bun:
 *   bun scripts/kernel-e2e/cursor-native-abort.ts
 *
 * It intentionally exercises both specialist modes:
 * - old: raw native BashTool passed to CursorExecHandlers (no injected signal)
 * - fixed: the same tool after injectNativeToolAbortSignal with the owner signal
 * and proves late-file/process behavior plus independent task isolation.
 *
 * It also drives the ordinary session lifecycle through the real Phi
 * promptSession/abortSession/disposeSession functions with the real Cursor
 * bridge and BashTool. Only the SDK prompt/abort transport is a local fixture:
 * there is no provider or network call.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CursorExecHandlers } from '@oh-my-pi/pi-coding-agent/cursor'
import { createBashTool } from '@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim'
import {
  abortSession,
  disposeSession,
  promptSession
} from '../../src/main/agent/engine/in-process/session-runtime'
import { sessions, type SessionEntry } from '../../src/main/agent/engine/in-process/state'
import { injectNativeToolAbortSignal } from '../../src/main/agent/engine/in-process/native-tool-abort'

const SCRIPT = `#!/bin/bash
set -euo pipefail
echo "$$ $(date +%s)" > started.txt
sleep 2
echo late > late.txt
`

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // Only "no such process" proves absence. Permission/unknown errors are
    // inconclusive and must fail the probe rather than masquerade as cleanup.
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

function alive(pid: number): boolean {
  try {
    const stat = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim()
    return stat.length > 0 && !stat.startsWith('Z')
  } catch {
    // Some hosts and sandboxes deny ps even though liveness is still observable.
    // Signal 0 is an independent existence check; a zombie may count as alive, so
    // keep the late-file assertion as the user-visible signal.
    return processExists(pid)
  }
}

function children(pid: number): number[] {
  try {
    return execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' })
      .split(/\s+/)
      .filter(Boolean)
      .map(Number)
      .filter((value) => Number.isSafeInteger(value) && value > 0)
  } catch {
    return []
  }
}

function processGroup(pid: number): number | null {
  try {
    return Number(
      execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim()
    )
  } catch {
    return null
  }
}

function cleanupGroup(pid: number): void {
  const pgid = processGroup(pid)
  if (pgid === pid && pid > 0) {
    try {
      process.kill(-pgid, 'SIGKILL')
    } catch {
      /* gone */
    }
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForFile(path: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(path)) return
    await wait(25)
  }
  throw new Error(`timed out waiting for ${path}`)
}

function setupTask(label: string): { dir: string; script: string } {
  const dir = mkdtempSync(join(tmpdir(), `phi-cursor-abort-${label}-`))
  const script = join(dir, 'slow.sh')
  writeFileSync(script, SCRIPT, { mode: 0o700 })
  return { dir, script }
}

function handlerFor(dir: string, tool: unknown): CursorExecHandlers {
  return new CursorExecHandlers({
    cwd: dir,
    tools: new Map([['bash', tool as never]])
  })
}

async function runMode(mode: 'old' | 'fixed'): Promise<{
  mode: string
  startedPid: number
  aliveAfterAbort: boolean
  lateFile: boolean
  handlerError: string | null
}> {
  const task = setupTask(mode)
  const owner = new AbortController()
  const bash = createBashTool(task.dir)
  if (mode === 'fixed') {
    injectNativeToolAbortSignal(
      { getToolByName: (name) => (name === 'bash' ? bash : undefined) },
      owner.signal
    )
  }
  const handlers = handlerFor(task.dir, bash)
  let handlerError: string | null = null
  const running = handlers
    .piBash({
      toolCallId: `cursor-${mode}`,
      args: { command: `/bin/bash ${task.script}`, timeout: 30 }
    } as never)
    .catch((error) => {
      handlerError = error instanceof Error ? error.message : String(error)
      return null
    })
  await waitForFile(join(task.dir, 'started.txt'))
  const pid = Number(readFileSync(join(task.dir, 'started.txt'), 'utf8').trim().split(/\s+/)[0])
  assert.ok(Number.isSafeInteger(pid) && pid > 0, `${mode}: started PID`)
  await wait(100)
  const childrenBefore = children(pid)
  assert.ok(childrenBefore.length > 0, `${mode}: sleep child present`)
  owner.abort()
  await wait(500)
  const aliveAfterAbort = alive(pid) || childrenBefore.some(alive)
  await wait(2_300)
  const lateFile = existsSync(join(task.dir, 'late.txt'))
  await Promise.race([running, wait(2_000)])
  cleanupGroup(pid)
  rmSync(task.dir, { recursive: true, force: true })
  return { mode, startedPid: pid, aliveAfterAbort, lateFile, handlerError }
}

async function runIsolation(): Promise<{ independentLate: boolean; abortedLate: boolean }> {
  const aborted = setupTask('isolation-a')
  const independent = setupTask('isolation-b')
  const ownerA = new AbortController()
  const ownerB = new AbortController()
  const bashA = createBashTool(aborted.dir)
  const bashB = createBashTool(independent.dir)
  injectNativeToolAbortSignal(
    { getToolByName: (name) => (name === 'bash' ? bashA : undefined) },
    ownerA.signal
  )
  injectNativeToolAbortSignal(
    { getToolByName: (name) => (name === 'bash' ? bashB : undefined) },
    ownerB.signal
  )
  const runA = handlerFor(aborted.dir, bashA)
    .piBash({
      toolCallId: 'isolation-a',
      args: { command: `/bin/bash ${aborted.script}`, timeout: 30 }
    } as never)
    .catch(() => null)
  const runB = handlerFor(independent.dir, bashB)
    .piBash({
      toolCallId: 'isolation-b',
      args: { command: `/bin/bash ${independent.script}`, timeout: 30 }
    } as never)
    .catch(() => null)
  await Promise.all([
    waitForFile(join(aborted.dir, 'started.txt')),
    waitForFile(join(independent.dir, 'started.txt'))
  ])
  const pidA = Number(readFileSync(join(aborted.dir, 'started.txt'), 'utf8').trim().split(/\s+/)[0])
  const pidB = Number(
    readFileSync(join(independent.dir, 'started.txt'), 'utf8').trim().split(/\s+/)[0]
  )
  ownerA.abort()
  await wait(2_300)
  const independentLate = existsSync(join(independent.dir, 'late.txt'))
  const abortedLate = existsSync(join(aborted.dir, 'late.txt'))
  await Promise.all([Promise.race([runA, wait(2_000)]), Promise.race([runB, wait(2_000)])])
  cleanupGroup(pidA)
  cleanupGroup(pidB)
  rmSync(aborted.dir, { recursive: true, force: true })
  rmSync(independent.dir, { recursive: true, force: true })
  return { independentLate, abortedLate }
}

type OrdinaryFixture = {
  id: string
  dir: string
  script: string
  signals: Array<AbortSignal | undefined>
  prompts: number
  sdkAbortCalls: number
  disposeCalls: number
}

/**
 * A local stand-in for the Cursor-driven SDK transport. The prompt executes the
 * real CursorExecHandlers -> real BashTool path exactly as a Cursor tool frame
 * would; abort/dispose only record the SDK calls so the test can prove Phi's
 * owner scope does the process cancellation, not the stubbed transport.
 */
function createOrdinarySession(label: string): OrdinaryFixture {
  const task = setupTask(label)
  const bash = createBashTool(task.dir)
  const handlers = new CursorExecHandlers({
    cwd: task.dir,
    tools: new Map([['bash', bash as never]])
  })
  const signals: Array<AbortSignal | undefined> = []
  const originalExecute = bash.execute.bind(bash)
  bash.execute = ((toolCallId, args, signal, onUpdate, context) => {
    signals.push(signal)
    return originalExecute(toolCallId, args, signal, onUpdate, context)
  }) as typeof bash.execute
  const fixture: OrdinaryFixture = {
    id: `ordinary-${label}`,
    dir: task.dir,
    script: task.script,
    signals,
    prompts: 0,
    sdkAbortCalls: 0,
    disposeCalls: 0
  }
  const session = {
    sessionFile: undefined,
    messages: [] as unknown[],
    thinkingLevel: 'high',
    model: { provider: 'fixture', id: 'cursor-fixture', name: 'Cursor fixture', input: ['text'] },
    sessionManager: { getCwd: () => task.dir },
    getToolByName: (name: string) => (name === 'bash' ? bash : undefined),
    prompt: async (text: string) => {
      fixture.prompts += 1
      await handlers.piBash({
        toolCallId: `${fixture.id}-${fixture.prompts}`,
        args: { command: text, timeout: 30 }
      } as never)
    },
    abort: async () => {
      fixture.sdkAbortCalls += 1
    },
    dispose: async () => {
      fixture.disposeCalls += 1
    }
  }
  sessions.set(fixture.id, {
    result: { session },
    agentDir: task.dir
  } as unknown as SessionEntry)
  return fixture
}

function startedPid(dir: string): number {
  return Number(readFileSync(join(dir, 'started.txt'), 'utf8').trim().split(/\s+/)[0])
}

async function settle(running: Promise<unknown>): Promise<void> {
  await Promise.race([running.catch(() => null), wait(3_000)])
}

function releaseOrdinary(fixture: OrdinaryFixture, pid?: number): void {
  sessions.delete(fixture.id)
  if (pid) cleanupGroup(pid)
  rmSync(fixture.dir, { recursive: true, force: true })
}

async function runOrdinaryAbortScenario(): Promise<{
  sdkAbortCalls: number
  lateFile: boolean
  processStopped: boolean
  firstSignalAborted: boolean
  nextPromptWorked: boolean
  nextSignalFresh: boolean
}> {
  const fixture = createOrdinarySession('abort')
  let pid: number | undefined
  const running = promptSession({
    sessionId: fixture.id,
    text: `/bin/bash ${fixture.script}`
  }) as Promise<unknown>
  try {
    await waitForFile(join(fixture.dir, 'started.txt'))
    pid = startedPid(fixture.dir)
    await abortSession({ sessionId: fixture.id })
    await wait(500)
    const firstSignalAborted = fixture.signals[0]?.aborted === true
    const processStopped = !alive(pid)
    await settle(running)
    await wait(2_200)
    const lateFile = existsSync(join(fixture.dir, 'late.txt'))
    const fastTarget = join(fixture.dir, 'fast.txt')
    await promptSession({
      sessionId: fixture.id,
      text: `printf fast > ${JSON.stringify(fastTarget)}`
    })
    const nextSignal = fixture.signals[1]
    return {
      sdkAbortCalls: fixture.sdkAbortCalls,
      lateFile,
      processStopped,
      firstSignalAborted,
      nextPromptWorked: existsSync(fastTarget),
      nextSignalFresh:
        nextSignal !== undefined && nextSignal !== fixture.signals[0] && !nextSignal.aborted
    }
  } finally {
    releaseOrdinary(fixture, pid)
  }
}

async function runOrdinaryDisposeScenario(): Promise<{
  disposeCalls: number
  lateFile: boolean
  signalAborted: boolean
}> {
  const fixture = createOrdinarySession('dispose')
  let pid: number | undefined
  const running = promptSession({
    sessionId: fixture.id,
    text: `/bin/bash ${fixture.script}`
  }) as Promise<unknown>
  try {
    await waitForFile(join(fixture.dir, 'started.txt'))
    pid = startedPid(fixture.dir)
    await disposeSession({ sessionId: fixture.id })
    await settle(running)
    await wait(500)
    const signalAborted = fixture.signals[0]?.aborted === true
    await wait(2_200)
    return {
      disposeCalls: fixture.disposeCalls,
      lateFile: existsSync(join(fixture.dir, 'late.txt')),
      signalAborted
    }
  } finally {
    releaseOrdinary(fixture, pid)
  }
}

async function runOrdinaryIsolationScenario(): Promise<{
  abortedLate: boolean
  independentLate: boolean
  abortedSignal: boolean
  independentSignal: boolean
}> {
  const aborted = createOrdinarySession('isolation-a')
  const independent = createOrdinarySession('isolation-b')
  let abortedPid: number | undefined
  let independentPid: number | undefined
  const runAborted = promptSession({
    sessionId: aborted.id,
    text: `/bin/bash ${aborted.script}`
  }) as Promise<unknown>
  const runIndependent = promptSession({
    sessionId: independent.id,
    text: `/bin/bash ${independent.script}`
  }) as Promise<unknown>
  try {
    await Promise.all([
      waitForFile(join(aborted.dir, 'started.txt')),
      waitForFile(join(independent.dir, 'started.txt'))
    ])
    abortedPid = startedPid(aborted.dir)
    independentPid = startedPid(independent.dir)
    await abortSession({ sessionId: aborted.id })
    await wait(2_300)
    return {
      abortedLate: existsSync(join(aborted.dir, 'late.txt')),
      independentLate: existsSync(join(independent.dir, 'late.txt')),
      abortedSignal: aborted.signals[0]?.aborted === true,
      independentSignal: independent.signals[0]?.aborted === true
    }
  } finally {
    await Promise.all([settle(runAborted), settle(runIndependent)])
    releaseOrdinary(aborted, abortedPid)
    releaseOrdinary(independent, independentPid)
  }
}

async function main(): Promise<void> {
  if (!existsSync(join(process.cwd(), 'src/main/agent/engine/in-process/native-tool-abort.ts')))
    throw new Error('run from the Phi worktree root')
  const old = await runMode('old')
  const fixed = await runMode('fixed')
  const isolation = await runIsolation()
  const ordinaryAbort = await runOrdinaryAbortScenario()
  const ordinaryDispose = await runOrdinaryDisposeScenario()
  const ordinaryIsolation = await runOrdinaryIsolationScenario()
  const checks = {
    oldProcessStayedAlive: old.aliveAfterAbort === true,
    oldLateFile: old.lateFile === true,
    fixedProcessStopped: fixed.aliveAfterAbort === false,
    fixedNoLateFile: fixed.lateFile === false,
    independentTaskCompleted: isolation.independentLate === true,
    abortedTaskNoLateFile: isolation.abortedLate === false,
    ordinarySdkAbortCalled: ordinaryAbort.sdkAbortCalls === 1,
    ordinaryProcessStopped: ordinaryAbort.processStopped === true,
    ordinaryNoLateFile: ordinaryAbort.lateFile === false,
    ordinaryFirstSignalAborted: ordinaryAbort.firstSignalAborted === true,
    ordinaryNextPromptWorked: ordinaryAbort.nextPromptWorked === true,
    ordinaryNextSignalFresh: ordinaryAbort.nextSignalFresh === true,
    ordinaryDisposeCalled: ordinaryDispose.disposeCalls === 1,
    ordinaryDisposeNoLateFile: ordinaryDispose.lateFile === false,
    ordinaryDisposeSignalAborted: ordinaryDispose.signalAborted === true,
    ordinaryIsolationAbortedNoLateFile: ordinaryIsolation.abortedLate === false,
    ordinaryIsolationOtherCompleted: ordinaryIsolation.independentLate === true,
    ordinaryIsolationAbortedSignal: ordinaryIsolation.abortedSignal === true,
    ordinaryIsolationOtherSignalFresh: ordinaryIsolation.independentSignal === false
  }
  console.log(
    JSON.stringify(
      { old, fixed, isolation, ordinaryAbort, ordinaryDispose, ordinaryIsolation, checks },
      null,
      2
    )
  )
  assert.deepEqual(checks, {
    oldProcessStayedAlive: true,
    oldLateFile: true,
    fixedProcessStopped: true,
    fixedNoLateFile: true,
    independentTaskCompleted: true,
    abortedTaskNoLateFile: true,
    ordinarySdkAbortCalled: true,
    ordinaryProcessStopped: true,
    ordinaryNoLateFile: true,
    ordinaryFirstSignalAborted: true,
    ordinaryNextPromptWorked: true,
    ordinaryNextSignalFresh: true,
    ordinaryDisposeCalled: true,
    ordinaryDisposeNoLateFile: true,
    ordinaryDisposeSignalAborted: true,
    ordinaryIsolationAbortedNoLateFile: true,
    ordinaryIsolationOtherCompleted: true,
    ordinaryIsolationAbortedSignal: true,
    ordinaryIsolationOtherSignalFresh: true
  })
}

await main()
