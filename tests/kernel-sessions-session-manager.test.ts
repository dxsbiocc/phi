import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import { resolveBunExecutable } from '../src/main/agent/engine/bun-executable'

const execFileAsync = promisify(execFile)
const factoryUrl = pathToFileURL(
  resolve('src/main/agent/engine/in-process/session-factory.ts')
).href

async function runManagerProbe(args: string[]): Promise<Record<string, unknown>> {
  const script = `
    import { existsSync } from 'node:fs'
    import { makeSessionManager } from ${JSON.stringify(factoryUrl)}
    const [operation, cwd, agentDir, journal] = process.argv.slice(1)
    try {
      const manager = await makeSessionManager(
        operation === 'create'
          ? { kind: 'persistent', path: journal }
          : { kind: 'open', path: journal, requireExisting: true, suppressBreadcrumb: true },
        cwd,
        agentDir
      )
      const result = {
        ok: true,
        sessionFile: manager.getSessionFile(),
        cwd: manager.getCwd(),
        exists: existsSync(journal)
      }
      await manager.close()
      console.log(JSON.stringify(result))
    } catch (error) {
      console.log(JSON.stringify({ ok: false, message: String(error), exists: existsSync(journal) }))
    }
  `
  const { stdout } = await execFileAsync(resolveBunExecutable(), ['--eval', script, ...args], {
    cwd: resolve('.'),
    timeout: 15_000
  })
  return JSON.parse(stdout.trim()) as Record<string, unknown>
}

test('kernel persistence materializes the OMP journal at the exact managed path', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-kernel-manager-'))
  const cwd = join(root, 'project')
  const agentDir = join(root, 'agent')
  const journal = join(agentDir, 'phi-kernel', 'sessions', 'session-1', 'journal.jsonl')
  mkdirSync(cwd)
  mkdirSync(join(agentDir, 'phi-kernel', 'sessions', 'session-1'), { recursive: true })
  try {
    assert.deepEqual(await runManagerProbe(['create', cwd, agentDir, journal]), {
      ok: true,
      sessionFile: journal,
      cwd,
      exists: true
    })
    assert.equal(existsSync(journal), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('kernel reopen fails closed when the managed journal is missing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-kernel-manager-missing-'))
  const cwd = join(root, 'project')
  const agentDir = join(root, 'agent')
  const journal = join(root, 'missing', 'journal.jsonl')
  mkdirSync(cwd)
  try {
    const result = await runManagerProbe(['open', cwd, agentDir, journal])
    assert.equal(result.ok, false)
    assert.match(String(result.message), /ENOENT|missing|no such file/i)
    assert.equal(result.exists, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
