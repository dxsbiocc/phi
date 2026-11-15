#!/usr/bin/env bun
/**
 * Real-SDK no-cloud regression for the Cursor native piBash abort path.
 *
 * Run on the host with Bun:
 *   bun scripts/kernel-e2e/cursor-native-abort.ts
 *
 * It intentionally exercises both modes:
 * - old: raw native BashTool passed to CursorExecHandlers (no injected signal)
 * - fixed: the same tool after injectNativeToolAbortSignal with the owner signal
 * and proves late-file/process behavior plus independent task isolation.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CursorExecHandlers } from '@oh-my-pi/pi-coding-agent/cursor'
import { createBashTool } from '@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim'
import { injectNativeToolAbortSignal } from '../../src/main/agent/engine/in-process/native-tool-abort'

const SCRIPT = `#!/bin/bash
set -euo pipefail
echo "$$ $(date +%s)" > started.txt
sleep 2
echo late > late.txt
`

function alive(pid: number): boolean {
  try {
    const stat = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim()
    return stat.length > 0 && !stat.startsWith('Z')
  } catch {
    return false
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

async function main(): Promise<void> {
  if (!existsSync(join(process.cwd(), 'src/main/agent/engine/in-process/native-tool-abort.ts')))
    throw new Error('run from the Phi worktree root')
  const old = await runMode('old')
  const fixed = await runMode('fixed')
  const isolation = await runIsolation()
  const checks = {
    oldProcessStayedAlive: old.aliveAfterAbort === true,
    oldLateFile: old.lateFile === true,
    fixedProcessStopped: fixed.aliveAfterAbort === false,
    fixedNoLateFile: fixed.lateFile === false,
    independentTaskCompleted: isolation.independentLate === true,
    abortedTaskNoLateFile: isolation.abortedLate === false
  }
  console.log(JSON.stringify({ old, fixed, isolation, checks }, null, 2))
  assert.deepEqual(checks, {
    oldProcessStayedAlive: true,
    oldLateFile: true,
    fixedProcessStopped: true,
    fixedNoLateFile: true,
    independentTaskCompleted: true,
    abortedTaskNoLateFile: true
  })
}

await main()
