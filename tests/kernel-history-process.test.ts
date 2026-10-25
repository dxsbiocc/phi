import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { makeSessionManager } from '../src/main/agent/engine/in-process/session-factory'
import { resolveBunExecutable } from '../src/main/agent/engine/bun-executable'
import {
  KernelSessionRepository,
  adoptedSessionId,
  kernelSessionMigrationPaths,
  readMigration
} from '../src/kernel/sessions'

const sessionsUrl = pathToFileURL(resolve('src/kernel/sessions/index.ts')).href
const sessionFactoryUrl = pathToFileURL(
  resolve('src/main/agent/engine/in-process/session-factory.ts')
).href

async function waitFor(
  predicate: () => boolean,
  description: string,
  stopped?: () => string | undefined
): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!predicate()) {
    const failure = stopped?.()
    if (failure) throw new Error(failure)
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`)
    await new Promise((resolveWait) => setTimeout(resolveWait, 20))
  }
}

for (const state of ['started', 'copied', 'verified', 'complete'] as const) {
  test(
    `SIGKILL after migration state ${state} resumes the one deterministic target`,
    { timeout: 30_000 },
    async () => {
      const root = mkdtempSync(join(tmpdir(), `phi-history-process-${state}-`))
      const cwd = join(root, 'project')
      const sourceRoot = join(root, 'source')
      const source = join(sourceRoot, 'journal.jsonl')
      const agentDir = join(root, 'agent')
      mkdirSync(cwd)
      mkdirSync(sourceRoot)
      const manager = await makeSessionManager({ kind: 'persistent', path: source }, cwd, agentDir)
      manager.appendMessage({ role: 'user', content: `before ${state}`, timestamp: Date.now() })
      await manager.close()
      const original = readFileSync(source)
      const originalMtime = statSync(source).mtimeMs
      const sourceSha256 = createHash('sha256').update(original).digest('hex')
      const sessionId = adoptedSessionId('phi-process-session', sourceSha256)
      const paths = kernelSessionMigrationPaths(agentDir, sessionId)
      const childScript = `
        import { KernelSessionRepository } from ${JSON.stringify(sessionsUrl)}
        import { makeSessionManager } from ${JSON.stringify(sessionFactoryUrl)}
        const [agentDir, sourceRoot, source, cwd] = process.argv.slice(1)
        const repository = new KernelSessionRepository(
          agentDir,
          'crashing-adopter',
          undefined,
          'child-process',
          async (path, initialCwd) => {
            const manager = await makeSessionManager(
              { kind: 'open', path, requireExisting: true, suppressBreadcrumb: true },
              initialCwd,
              agentDir
            )
            await manager.close()
          }
        )
        await repository.adopt({
          source: {
            kind: 'omp-journal', path: source, cwd,
            origin: 'desktop-local', phiSessionId: 'phi-process-session'
          }
        }, { allowedSourceRoots: [sourceRoot] })
      `
      const child = spawn(
        resolveBunExecutable(),
        ['--eval', childScript, agentDir, sourceRoot, source, cwd],
        {
          cwd: resolve('.'),
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, PHI_KERNEL_HISTORY_TEST_PAUSE: state }
        }
      )
      let stderr = ''
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk
      })
      const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolveExit) => child.once('exit', (code, signal) => resolveExit({ code, signal }))
      )
      const repository = new KernelSessionRepository(
        agentDir,
        `recovery-${state}`,
        undefined,
        'parent-process',
        async (path, initialCwd) => {
          const reopened = await makeSessionManager(
            { kind: 'open', path, requireExisting: true, suppressBreadcrumb: true },
            initialCwd,
            agentDir
          )
          await reopened.close()
        }
      )
      try {
        await waitFor(
          () => existsSync(join(paths.directory, `history-test-pause-${state}.marker`)),
          `${state} migration pause marker`,
          () =>
            child.exitCode !== null || child.signalCode !== null
              ? `adopter exited before pause: ${stderr}`
              : undefined
        )
        assert.equal(child.kill('SIGKILL'), true)
        const outcome = await exit
        assert.equal(outcome.signal, 'SIGKILL', stderr)

        const recovered = await repository.open(sessionId)
        assert.equal(recovered.manifest.sessionId, sessionId)
        assert.equal((await readMigration(paths.migration))?.state, 'complete')
        assert.equal((await repository.list()).sessions.length, 1)
        assert.deepEqual(readFileSync(source), original)
        assert.equal(statSync(source).mtimeMs, originalMtime)
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        await repository.close(sessionId)
        rmSync(root, { recursive: true, force: true })
      }
    }
  )
}
