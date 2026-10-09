import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import assert from 'node:assert/strict'

import {
  findWrapperCompositionEntry,
  resetWrapperCompositionCatalogCache
} from '../../src/main/agent/wrappers/composition/discovery'
import { writeGffreadFixture } from './compositionFixtures'
import {
  getWrapperTreeDir,
  getWrapperTreeOwnershipPath
} from '../../src/main/agent/packages/wrapper-tree'

/** An installed test wrapper that needs no downloads: its default `gff` is a local fixture. */
export const WRAPPER_ID = 'nf-core/modules/gffread'

/**
 * A stand-in `nextflow`. Modes (FAKE_NF_MODE): `fail` exits 1; `hang` prints a
 * process line and never exits; anything else prints process lines, waits
 * FAKE_NF_MS (default 200) and writes the wrapper's primary output. With
 * FAKE_NF_GATE set, it instead waits until that file exists, so a test can hold
 * the pipeline open for as long as it needs (see Sandbox.releaseGate).
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
  const finish = () => {
    fs.mkdirSync(path.join(params.outdir, 'gffread'), { recursive: true })
    fs.writeFileSync(path.join(params.outdir, 'gffread', 'out.gtf'), 'x')
    console.log('[SUCCESS] completed=1 failed=0 cached=0')
    process.exit(0)
  }
  const gate = process.env.FAKE_NF_GATE
  if (gate) {
    setInterval(() => {
      if (fs.existsSync(gate)) finish()
    }, 20)
  } else {
    setTimeout(finish, Number(process.env.FAKE_NF_MS || 200))
  }
}
`

/** A shell "nextflow" that leaves a background grandchild, to prove the whole process group dies. */
export const FAKE_NEXTFLOW_TREE = `#!/bin/sh
if [ "$1" = "-version" ]; then
  echo '      version 26.04.6 build 12646'
  exit 0
fi
if [ -n "$FAKE_NF_GATE" ]; then
  while [ ! -e "$FAKE_NF_GATE" ]; do sleep 0.02; done
fi
echo $$ > "$FAKE_NF_PIDFILE"
sleep 300 &
echo $! > "$FAKE_NF_PIDFILE.child"
: > "$FAKE_NF_PIDFILE.ready"
wait
`

export interface Sandbox {
  root: string
  agentDir: string
  outdir: string
  wrappersRoot: string
  pidFile: string
  useFake: (script?: string) => void
  /** Hold the fake pipeline open (FAKE_NF_GATE) until `releaseGate` is called. */
  holdGate: () => void
  releaseGate: () => void
}

const ENV_KEYS = [
  'NEXTFLOW_BIN',
  'PI_CODING_AGENT_DIR',
  'FAKE_NF_PIDFILE',
  'FAKE_NF_MODE',
  'FAKE_NF_MS',
  'FAKE_NF_GATE',
  'FAKE_SETSID_GATE'
]

function seedGffreadPackage(agentDir: string): void {
  const tree = getWrapperTreeDir(agentDir)
  const target = writeGffreadFixture(tree)
  const paths: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (lstatSync(path).isDirectory()) walk(path)
      else paths.push(relative(tree, path).split('\\').join('/'))
    }
  }
  walk(target)
  const id = 'module-nf-core-gffread'
  const version = '1.0.0'
  const installedAt = '2026-10-02T00:00:00.000Z'
  const manifest = {
    schemaVersion: 1,
    id,
    type: 'wrapper',
    version,
    title: 'nf-core/gffread module family',
    summary: 'GffRead wrapper fixture.',
    dependsOn: [],
    files: 'files.json'
  }
  mkdirSync(join(getWrapperTreeOwnershipPath(agentDir), '..'), { recursive: true })
  writeFileSync(
    getWrapperTreeOwnershipPath(agentDir),
    `${JSON.stringify(
      {
        version: 1,
        packages: {
          [id]: {
            version,
            title: manifest.title,
            summary: manifest.summary,
            manifest,
            source: {
              registry: 'test-fixture',
              id,
              type: 'wrapper',
              version,
              sha256: '0'.repeat(64),
              installedAt,
              installedBy: 'user'
            },
            paths: paths.sort()
          }
        }
      },
      null,
      2
    )}\n`
  )
}

export async function withSandbox(fn: (sandbox: Sandbox) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'phi-wrapper-runs-'))
  const saved = { ...process.env }
  const sandbox: Sandbox = {
    root,
    agentDir: join(root, 'agent'),
    outdir: join(root, 'out'),
    wrappersRoot: getWrapperTreeDir(join(root, 'agent')),
    pidFile: join(root, 'nf.pid'),
    useFake: (script = FAKE_NEXTFLOW) => {
      const bin = join(root, 'fake-nextflow')
      writeFileSync(bin, script)
      chmodSync(bin, 0o755)
      process.env.NEXTFLOW_BIN = bin
    },
    holdGate: () => {
      process.env.FAKE_NF_GATE = join(root, 'nf.gate')
    },
    releaseGate: () => {
      writeFileSync(join(root, 'nf.gate'), '')
    }
  }
  process.env.PI_CODING_AGENT_DIR = sandbox.agentDir
  process.env.FAKE_NF_PIDFILE = sandbox.pidFile
  seedGffreadPackage(sandbox.agentDir)
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

/**
 * Fails with `what` if `promise` has not settled by the deadline. For calls that must not
 * wait on a gated pipeline: the bound is only there so a regression fails with a clear
 * message instead of hanging until the runner's test timeout, so keep it generous.
 */
export async function settlesWithin<T>(
  promise: Promise<T>,
  what: string,
  timeoutMs = 60_000
): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${what} (still pending after ${timeoutMs} ms)`)),
      timeoutMs
    )
  })
  try {
    return await Promise.race([promise, deadline])
  } finally {
    clearTimeout(timer)
  }
}

export function bundledEntry(): NonNullable<ReturnType<typeof findWrapperCompositionEntry>> {
  const found = findWrapperCompositionEntry(WRAPPER_ID)
  assert.ok(found, `${WRAPPER_ID} should be installed as a test fixture`)
  return found
}

export function pidFileReady(sandbox: Sandbox): boolean {
  return existsSync(sandbox.pidFile)
}
