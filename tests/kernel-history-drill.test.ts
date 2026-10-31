import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import { resolveBunExecutable } from '../src/main/agent/engine/bun-executable'

function runDrillProbe(
  phiSessions: string,
  out: string,
  home: string
): { ok: boolean; message?: string } {
  const script = [
    "import { runKernelHistoryDrill } from './scripts/kernel-history-drill'",
    'const { PROBE_PHI_SESSIONS: phiSessions, PROBE_OUT: out } = process.env',
    'try {',
    '  await runKernelHistoryDrill({ phiSessions, out, copyFirst: true })',
    '  console.log(JSON.stringify({ ok: true }))',
    '} catch (error) {',
    '  console.log(JSON.stringify({ ok: false, message: error instanceof Error ? error.message : String(error) }))',
    '}'
  ].join('\n')
  const stdout = execFileSync(resolveBunExecutable(), ['-e', script], {
    cwd: resolve('.'),
    encoding: 'utf8',
    env: { ...process.env, HOME: home, PROBE_PHI_SESSIONS: phiSessions, PROBE_OUT: out },
    stdio: ['ignore', 'pipe', 'inherit']
  })
  return JSON.parse(stdout.trim()) as { ok: boolean; message?: string }
}

test('drill refuses a missing output directory reached through a symlink into ~/.phi', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-history-drill-output-'))
  const sessions = join(root, 'sessions')
  const link = join(root, 'phi-link')
  const unique = `k2-4-must-not-create-${randomUUID()}`
  // A home of its own: the guard resolves ~/.phi, which a fresh host does not have.
  const home = join(root, 'home')
  const forbiddenDirectory = join(home, '.phi', unique)
  mkdirSync(sessions)
  mkdirSync(join(home, '.phi'), { recursive: true })
  symlinkSync(join(home, '.phi'), link)
  assert.equal(existsSync(forbiddenDirectory), false)
  try {
    const result = runDrillProbe(sessions, join(link, unique, 'report.json'), home)
    assert.equal(result.ok, false)
    assert.match(result.message ?? '', /refusing to write a drill report inside ~\/\.phi/i)
    assert.equal(existsSync(forbiddenDirectory), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
