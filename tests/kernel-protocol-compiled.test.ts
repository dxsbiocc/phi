import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  encodeFrame,
  parseFrame,
  PHI_KERNEL_PROTOCOL_VERSION,
  type JsonValue,
  type KernelRequestFrame
} from '../src/shared/kernel-protocol'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

function packageVersion(packagePath: string): string {
  const metadata = JSON.parse(readFileSync(packagePath, 'utf8')) as { version?: unknown }
  const version = metadata.version
  if (typeof version !== 'string' || version.length === 0) {
    assert.fail(`${packagePath} does not declare a version`)
  }
  return version
}

function helloRequest(): KernelRequestFrame {
  return {
    kind: 'request',
    id: 'compiled-hello',
    method: 'kernel.hello',
    generation: 0,
    params: {
      protocol: PHI_KERNEL_PROTOCOL_VERSION,
      client: { name: 'compiled-kernel-test', version: '1.0.0' }
    }
  }
}

function readLine(child: ChildProcessWithoutNullStreams): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('Timed out waiting for compiled kernel response'))
    }, 5_000)
    const cleanup = (): void => {
      clearTimeout(timeout)
      child.stdout.off('data', onData)
      child.stdout.off('end', onEnd)
    }
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8')
      const delimiter = buffer.indexOf('\n')
      if (delimiter === -1) return
      cleanup()
      resolve(buffer.slice(0, delimiter))
    }
    const onEnd = (): void => {
      cleanup()
      reject(new Error('Compiled kernel stdout closed before a response'))
    }
    child.stdout.on('data', onData)
    child.stdout.on('end', onEnd)
  })
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('Compiled kernel did not exit after stdin closed'))
    }, 2_000)
    child.once('exit', (code) => {
      clearTimeout(timeout)
      resolve(code)
    })
  })
}

test(
  'the compiled kernel keeps package versions after it is copied elsewhere',
  { timeout: 30_000 },
  async () => {
    const buildDirectory = mkdtempSync(path.join(tmpdir(), 'phi-kernel-compile-'))
    const runDirectory = mkdtempSync(path.join(tmpdir(), 'phi-kernel-run-'))
    const buildBinary = path.join(buildDirectory, 'phi-kernel')
    const runBinary = path.join(runDirectory, 'phi-kernel')
    let child: ChildProcessWithoutNullStreams | undefined

    try {
      const build = spawnSync(
        'bun',
        ['build', '--compile', 'src/kernel/main.ts', '--outfile', buildBinary],
        {
          cwd: repoRoot,
          encoding: 'utf8'
        }
      )
      assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`)

      copyFileSync(buildBinary, runBinary)
      chmodSync(runBinary, 0o755)
      child = spawn(runBinary, [], {
        cwd: runDirectory,
        stdio: ['pipe', 'pipe', 'pipe']
      })
      let diagnostics = ''
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        diagnostics += chunk
      })

      const responseLine = readLine(child)
      child.stdin.write(encodeFrame(helloRequest()))
      const parsed = parseFrame(await responseLine)
      assert.ok('kind' in parsed)
      assert.equal(parsed.kind, 'response')
      assert.equal(parsed.id, 'compiled-hello')
      assert.equal(parsed.ok, true)
      assert.equal(typeof parsed.result, 'object')
      assert.ok(parsed.result !== null && !Array.isArray(parsed.result))
      const result = parsed.result as Record<string, JsonValue>
      assert.deepEqual(result.kernel, {
        version: packageVersion(path.join(repoRoot, 'package.json')),
        ompVersion: packageVersion(
          path.join(repoRoot, 'node_modules/@oh-my-pi/pi-coding-agent/package.json')
        )
      })

      const exit = waitForExit(child)
      child.stdin.end()
      assert.equal(await exit, 0)
      assert.equal(diagnostics, '')
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      rmSync(buildDirectory, { recursive: true, force: true })
      rmSync(runDirectory, { recursive: true, force: true })
    }
  }
)
