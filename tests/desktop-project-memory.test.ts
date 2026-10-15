import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { StringDecoder } from 'node:string_decoder'
import test from 'node:test'
import { resolveBunExecutable } from '../src/main/agent/engine/bun-executable'
import { startProjectMemoryModel } from './helpers/projectMemoryProvider'

const CONTROL_PREFIX = 'PHI_MEMORY_CONTRACT_CONTROL:'

for (const mode of ['summary', 'learn-clear', 'cancel-peer'])
  test(`desktop project memory actual SDK: ${mode}`, { timeout: 60000 }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'phi-project-memory-contract-'))
    const home = join(root, 'home'),
      agent = join(root, 'agent')
    // Keep the HTTP server in real Node. Bun's node:http POST/SSE shim does
    // not reliably report a disconnected client through either close event.
    const provider = await startProjectMemoryModel()
    t.after(() => provider.close())
    await mkdir(home)
    await mkdir(agent)
    const bun = resolveBunExecutable()
    const guard = fileURLToPath(new URL('./engine-contract/network-guard.ts', import.meta.url))
    const guarded = join(root, 'bun')
    await writeFile(
      guarded,
      `#!/bin/sh\nexec '${bun.replace(/'/g, "'\\''")}' --no-env-file --preload '${guard.replace(/'/g, "'\\''")}' "$@"\n`,
      { mode: 0o700 }
    )
    const child = spawn(
      bun,
      [
        '--no-env-file',
        '--preload',
        guard,
        fileURLToPath(new URL('./helpers/desktopProjectMemoryOracle.ts', import.meta.url)),
        mode
      ],
      {
        cwd: process.cwd(),
        env: {
          PATH: process.env.PATH,
          HOME: home,
          PI_CODING_AGENT_DIR: agent,
          PHI_BUN_PATH: guarded,
          PHI_MEMORY_TEST_GUARD: guard,
          PHI_MEMORY_TEST_PROVIDER_URL: provider.url,
          TMPDIR: root,
          NO_PROXY: '127.0.0.1,localhost'
        },
        stdio: ['pipe', 'pipe', 'pipe']
      }
    )
    t.signal.addEventListener('abort', () => child.kill('SIGTERM'), { once: true })
    let output = ''
    let pending = ''
    const decoder = new StringDecoder('utf8')
    child.stdin.on('error', () => {})
    const consumeLine = (line: string): void => {
      if (!line.startsWith(CONTROL_PREFIX)) {
        output = (output + line + '\n').slice(-16000)
        return
      }
      const command = JSON.parse(line.slice(CONTROL_PREFIX.length)) as {
        id: number
        type: 'snapshot' | 'hold'
        project?: 'A' | 'B'
      }
      let result: unknown
      if (command.type === 'hold' && (command.project === 'A' || command.project === 'B')) {
        provider.holdProject(command.project)
        result = null
      } else if (command.type === 'snapshot') {
        result = {
          requests: provider.memoryRequests,
          heldClosed: { A: provider.heldClosed('A'), B: provider.heldClosed('B') }
        }
      } else throw new Error('Unknown private memory contract control')
      child.stdin.write(CONTROL_PREFIX + JSON.stringify({ id: command.id, result }) + '\n')
    }
    child.stdout.on('data', (data) => {
      pending += decoder.write(data)
      for (;;) {
        const newline = pending.indexOf('\n')
        if (newline < 0) break
        consumeLine(pending.slice(0, newline))
        pending = pending.slice(newline + 1)
      }
    })
    child.stderr.on('data', (data) => {
      output = (output + data).slice(-16000)
    })
    try {
      const code = await new Promise((resolve, reject) => {
        child.once('error', reject)
        child.once('close', resolve)
      })
      assert.equal(code, 0, output)
      t.diagnostic(output.trim())
    } finally {
      child.kill('SIGTERM')
      await provider.close()
      await rm(root, { recursive: true, force: true })
    }
  })
