import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

import {
  findWrapperCompositionEntry,
  resetWrapperCompositionCatalogCache
} from '../../src/main/agent/wrappers/composition/discovery'

/** A bundled wrapper that needs no downloads: its default `gff` is a local fixture. */
export const WRAPPER_ID = 'nf-core/modules/gffread'

/**
 * A stand-in `nextflow`. Modes (FAKE_NF_MODE): `fail` exits 1; `hang` prints a
 * process line and never exits; anything else prints process lines, waits
 * FAKE_NF_MS (default 200) and writes the wrapper's primary output.
 */
export const FAKE_NEXTFLOW = `#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const args = process.argv.slice(2)
if (args[0] === '-version') {
  console.log('      version 26.04.6 build 12646')
  process.exit(0)
}
const params = JSON.parse(fs.readFileSync(args[args.indexOf('-params-file') + 1], 'utf8'))
if (process.env.FAKE_NF_PIDFILE) fs.writeFileSync(process.env.FAKE_NF_PIDFILE, String(process.pid))
const mode = process.env.FAKE_NF_MODE
console.log('[PIPELINE] main.nf | profile=' + args[args.indexOf('-profile') + 1])
if (mode === 'fail') {
  console.error('boom: pipeline failed')
  process.exit(1)
} else if (mode === 'hang') {
  console.log('[PROCESS 87/ef5c73] GFFREAD (genome)')
  setInterval(() => {}, 1000)
} else {
  console.log('[PROCESS 87/ef5c73] GFFREAD (genome)')
  setTimeout(() => {
    fs.mkdirSync(path.join(params.outdir, 'gffread'), { recursive: true })
    fs.writeFileSync(path.join(params.outdir, 'gffread', 'out.gtf'), 'x')
    console.log('[SUCCESS] completed=1 failed=0 cached=0')
    process.exit(0)
  }, Number(process.env.FAKE_NF_MS || 200))
}
`

/** A shell "nextflow" that leaves a background grandchild, to prove the whole process group dies. */
export const FAKE_NEXTFLOW_TREE = `#!/bin/sh
echo $$ > "$FAKE_NF_PIDFILE"
sleep 300 &
echo $! > "$FAKE_NF_PIDFILE.child"
wait
`

export interface Sandbox {
  root: string
  agentDir: string
  outdir: string
  pidFile: string
  useFake: (script?: string) => void
}

const ENV_KEYS = [
  'NEXTFLOW_BIN',
  'PI_CODING_AGENT_DIR',
  'FAKE_NF_PIDFILE',
  'FAKE_NF_MODE',
  'FAKE_NF_MS'
]

export async function withSandbox(fn: (sandbox: Sandbox) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'phi-wrapper-runs-'))
  const saved = { ...process.env }
  const sandbox: Sandbox = {
    root,
    agentDir: join(root, 'agent'),
    outdir: join(root, 'out'),
    pidFile: join(root, 'nf.pid'),
    useFake: (script = FAKE_NEXTFLOW) => {
      const bin = join(root, 'fake-nextflow')
      writeFileSync(bin, script)
      chmodSync(bin, 0o755)
      process.env.NEXTFLOW_BIN = bin
    }
  }
  process.env.PI_CODING_AGENT_DIR = sandbox.agentDir
  process.env.FAKE_NF_PIDFILE = sandbox.pidFile
  resetWrapperCompositionCatalogCache()
  try {
    await fn(sandbox)
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
    rmSync(root, { recursive: true, force: true })
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Polls until `condition` holds. These waits are on real child processes starting or
 * dying, which under a loaded full test run (dozens of test files in parallel) can take
 * several seconds; the generous default only costs time when a test is failing anyway.
 */
export async function waitFor(condition: () => boolean, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs} ms waiting for: ${String(condition)}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

export function bundledEntry(): NonNullable<ReturnType<typeof findWrapperCompositionEntry>> {
  const found = findWrapperCompositionEntry(WRAPPER_ID)
  assert.ok(found, `${WRAPPER_ID} should be bundled`)
  return found
}

export function pidFileReady(sandbox: Sandbox): boolean {
  return existsSync(sandbox.pidFile)
}
