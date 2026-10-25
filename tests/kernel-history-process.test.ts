import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

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

function runManagerProbe(
  operation: 'create' | 'open',
  path: string,
  cwd: string,
  agentDir: string,
  message = ''
): void {
  const script = `
    import { makeSessionManager } from ${JSON.stringify(sessionFactoryUrl)}
    const { PROBE_OPERATION: operation, PROBE_PATH: path, PROBE_CWD: cwd, PROBE_AGENT_DIR: agentDir, PROBE_MESSAGE: message } = process.env
    const manager = await makeSessionManager(
      operation === 'create'
        ? { kind: 'persistent', path }
        : { kind: 'open', path, requireExisting: true, suppressBreadcrumb: true },
      cwd,
      agentDir
    )
    if (operation === 'create') {
      manager.appendMessage({ role: 'user', content: message, timestamp: Date.now() })
    }
    await manager.close()
  `
  execFileSync(resolveBunExecutable(), ['--eval', script], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      PROBE_OPERATION: operation,
      PROBE_PATH: path,
      PROBE_CWD: cwd,
      PROBE_AGENT_DIR: agentDir,
      PROBE_MESSAGE: message
    },
    stdio: ['ignore', 'ignore', 'inherit']
  })
}

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
      runManagerProbe('create', source, cwd, agentDir, `before ${state}`)
      const original = readFileSync(source)
      const originalMtime = statSync(source).mtimeMs
      const sourceSha256 = createHash('sha256').update(original).digest('hex')
      const sessionId = adoptedSessionId('phi-process-session', sourceSha256)
      const paths = kernelSessionMigrationPaths(agentDir, sessionId)
      const childScript = `
        import { KernelSessionRepository } from ${JSON.stringify(sessionsUrl)}
        import { makeSessionManager } from ${JSON.stringify(sessionFactoryUrl)}
        const { PROBE_AGENT_DIR: agentDir, PROBE_SOURCE_ROOT: sourceRoot, PROBE_SOURCE: source, PROBE_CWD: cwd } = process.env
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
      const child = spawn(resolveBunExecutable(), ['--eval', childScript], {
        cwd: resolve('.'),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PHI_KERNEL_HISTORY_TEST_PAUSE: state,
          PROBE_AGENT_DIR: agentDir,
          PROBE_SOURCE_ROOT: sourceRoot,
          PROBE_SOURCE: source,
          PROBE_CWD: cwd
        }
      })
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
          runManagerProbe('open', path, initialCwd, agentDir)
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
