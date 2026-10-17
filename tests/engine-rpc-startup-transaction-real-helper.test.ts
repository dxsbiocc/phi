import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import {
  remoteHelperReadyMarkerIdentity,
  serializeRemoteHelperReadyMarker
} from '../src/main/agent/remote-helper-marker'
import {
  runRpcStartupTransaction,
  type RpcStartupTransaction
} from '../src/main/agent/engine/rpc/startup-transaction'
import type { RemoteExecResult } from '../src/main/agent/wrappers/remote-ssh-session'
import { buildRealHelperBinary, type RealHelperBinary } from './helpers/realHelperBinary'

// These tests run the startup transaction script against the real, freshly
// built Go phi-helper (no TypeScript stand-in), exercising the
// project-plugin-guard and remote-session-preflight subcommands end to end.

let buildDirectory = ''
let helper: RealHelperBinary

before(async () => {
  buildDirectory = await realpath(await mkdtemp(join(tmpdir(), 'phi-startup-real-helper-build-')))
  helper = await buildRealHelperBinary(buildDirectory)
})

after(async () => {
  await rm(buildDirectory, { recursive: true, force: true })
})

interface Fixture {
  root: string
  home: string
  runtimeRoot: string
  projectRoot: string
  helperPath: string
  helperMarker: Buffer
  helperDirectory: string
  managedRoot: string
}

async function fixture(): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'phi-startup-real-helper-')))
  const home = join(root, 'home')
  const runtimeRoot = join(home, 'runtime')
  const projectRoot = join(home, 'project')
  const managedRoot = join(runtimeRoot, 'remote-helper')
  const helperDirectory = join(managedRoot, helper.version)
  for (const directory of [home, runtimeRoot, projectRoot, managedRoot, helperDirectory]) {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await chmod(directory, 0o700)
  }
  const helperPath = join(helperDirectory, 'phi-helper')
  await writeFile(helperPath, await readFile(helper.path), { mode: 0o700 })
  await chmod(helperPath, 0o700)
  const helperMarker = Buffer.from(
    serializeRemoteHelperReadyMarker(
      remoteHelperReadyMarkerIdentity({ version: helper.version, sha256: helper.sha256 })
    )
  )
  await writeFile(join(helperDirectory, '.phi-ready.json'), helperMarker, { mode: 0o600 })
  return {
    root,
    home,
    runtimeRoot,
    projectRoot,
    helperPath,
    helperMarker,
    helperDirectory,
    managedRoot
  }
}

function run(home: string, command: string, input: string): Promise<RemoteExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command], {
      env: { PATH: process.env.PATH, HOME: home },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ stdout, stderr, code, signal }))
    child.stdin.on('error', () => undefined)
    child.stdin.end(input)
  })
}

function transaction(
  f: Fixture,
  extra: Partial<RpcStartupTransaction> = {}
): RpcStartupTransaction {
  const generation = join(f.runtimeRoot, 'rpc-sessions', 'generation-real')
  return {
    runtimeRoot: f.runtimeRoot,
    projectRoot: f.projectRoot,
    projectPluginGuardHelper: f.helperPath,
    markers: [
      {
        item: 'helper',
        managedRoot: f.managedRoot,
        directory: f.helperDirectory,
        path: join(f.helperDirectory, '.phi-ready.json'),
        bytes: f.helperMarker
      }
    ],
    directories: [
      { path: join(f.runtimeRoot, 'rpc-sessions') },
      { path: generation, ifAbsent: true }
    ],
    files: [
      {
        item: 'bootstrap-config',
        path: join(generation, 'config.json'),
        bytes: Buffer.from('{"schema":1}\n'),
        mode: 0o600,
        ifAbsent: true
      }
    ],
    ...extra
  }
}

const execute = (
  f: Fixture,
  tx: RpcStartupTransaction
): ReturnType<typeof runRpcStartupTransaction> =>
  runRpcStartupTransaction({ execWithInput: (command, input) => run(f.home, command, input) }, tx)

async function installToolPlugin(f: Fixture): Promise<void> {
  const plugins = join(f.projectRoot, '.omp', 'plugins')
  const plugin = join(plugins, 'node_modules', 'evil')
  await mkdir(plugin, { recursive: true, mode: 0o700 })
  await writeFile(join(plugins, 'package.json'), '{"dependencies":{"evil":"1"}}')
  await writeFile(join(plugin, 'package.json'), '{"omp":{"tools":["tool.ts"]}}')
  await writeFile(join(plugin, 'tool.ts'), 'export {}')
}

test('the helper that carries the startup subcommands is not version 0.2.0 or older', () => {
  const [major = 0, minor = 0] = helper.version.split('.').map(Number)
  assert.ok(
    major > 0 || minor >= 3,
    `helper protocol additions require a minor bump past 0.2.0, got ${helper.version}`
  )
})

test('startup runs the real helper plugin guard and publishes the generation', async () => {
  const f = await fixture()
  try {
    const execution = await execute(f, transaction(f))
    assert.equal(execution.result.status, 'ready')
    assert.deepEqual(execution.result.checks, [{ item: 'project_plugin_guard', status: 'ready' }])
    assert.deepEqual(execution.result.markers, [{ item: 'helper', status: 'ready' }])
    assert.equal(
      await readFile(join(f.runtimeRoot, 'rpc-sessions', 'generation-real', 'config.json'), 'utf8'),
      '{"schema":1}\n'
    )
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('real helper plugin guard refuses a project plugin tool before anything is published', async () => {
  const f = await fixture()
  try {
    await installToolPlugin(f)
    await assert.rejects(execute(f, transaction(f)), /PROJECT_PLUGIN_GUARD/)
    await assert.rejects(stat(join(f.runtimeRoot, 'rpc-sessions')), { code: 'ENOENT' })
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

async function resumeFixture(f: Fixture): Promise<{
  tx: RpcStartupTransaction
  manifest: Buffer
  journalPath: string
  manifestPath: string
}> {
  const session = join(f.runtimeRoot, 'sessions', 's1')
  const journals = join(session, 'journals')
  await mkdir(journals, { recursive: true, mode: 0o700 })
  for (const directory of [join(f.runtimeRoot, 'sessions'), session, journals])
    await chmod(directory, 0o700)
  const manifest = Buffer.from('{"schema":1,"session":"s1"}\n')
  const manifestPath = join(session, 'manifest.json')
  const journalPath = join(journals, 'j.jsonl')
  await writeFile(manifestPath, manifest, { mode: 0o600 })
  await writeFile(
    journalPath,
    `${JSON.stringify({
      type: 'session',
      version: 3,
      id: 'omp-1',
      timestamp: '2030-01-01T00:00:00.000Z',
      cwd: f.projectRoot
    })}\n{"type":"message"}\n`,
    { mode: 0o600 }
  )
  return {
    manifest,
    manifestPath,
    journalPath,
    tx: transaction(f, {
      resume: {
        manifestPath,
        manifestSha256: createHash('sha256').update(manifest).digest('hex'),
        manifestBytes: manifest.length,
        journalPath,
        ompSessionId: 'omp-1'
      }
    })
  }
}

test('startup returns the real helper resume identity for a resumed session', async () => {
  const f = await fixture()
  try {
    const resume = await resumeFixture(f)
    const execution = await execute(f, resume.tx)
    assert.equal(execution.result.status, 'ready')
    assert.deepEqual(execution.result.resume?.manifest, {
      path: resume.manifestPath,
      size: resume.manifest.length,
      sha256: createHash('sha256').update(resume.manifest).digest('hex')
    })
    const journal = execution.result.resume?.journal
    assert.equal(journal?.journalPath, resume.journalPath)
    assert.equal(journal?.ompSessionId, 'omp-1')
    assert.equal(journal?.cwd, f.projectRoot)
    assert.equal(journal?.verification, 'bounded-header')
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

for (const scenario of [
  {
    name: 'manifest digest differs',
    mutate: async (r: Awaited<ReturnType<typeof resumeFixture>>) =>
      writeFile(r.manifestPath, '{"schema":1,"session":"tampered"}\n'.padEnd(r.manifest.length)),
    expect: /RESUME_IDENTITY/
  },
  {
    name: 'journal belongs to another OMP session',
    mutate: async (r: Awaited<ReturnType<typeof resumeFixture>>) =>
      writeFile(
        r.journalPath,
        `${JSON.stringify({ type: 'session', version: 3, id: 'other', timestamp: '2030-01-01T00:00:00.000Z', cwd: '/' })}\n`,
        { mode: 0o600 }
      ),
    expect: /RESUME_IDENTITY/
  },
  {
    name: 'journal is not private',
    mutate: async (r: Awaited<ReturnType<typeof resumeFixture>>) => chmod(r.journalPath, 0o644),
    expect: /RESUME_IDENTITY/
  },
  {
    name: 'journal is missing',
    mutate: async (r: Awaited<ReturnType<typeof resumeFixture>>) => rm(r.journalPath),
    expect: /RESUME_IDENTITY/
  }
] as const) {
  test(`real helper refuses a resumed session when ${scenario.name}`, async () => {
    const f = await fixture()
    try {
      const resume = await resumeFixture(f)
      await scenario.mutate(resume)
      await assert.rejects(execute(f, resume.tx), scenario.expect)
      // Directories are created before the identity check, but no file is published.
      await assert.rejects(
        stat(join(f.runtimeRoot, 'rpc-sessions', 'generation-real', 'config.json')),
        { code: 'ENOENT' }
      )
    } finally {
      await rm(f.root, { recursive: true, force: true })
    }
  })
}

test('a helper binary whose marker does not match is repaired, never executed', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.helperDirectory, '.phi-ready.json'), '{"schema":1}\n', { mode: 0o600 })
    const execution = await execute(f, transaction(f))
    assert.equal(execution.result.status, 'repair')
    assert.deepEqual(execution.result.markers, [
      { item: 'helper', status: 'repair', reason: 'wrong_hash' }
    ])
    await assert.rejects(stat(join(f.runtimeRoot, 'rpc-sessions')), { code: 'ENOENT' })
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})
