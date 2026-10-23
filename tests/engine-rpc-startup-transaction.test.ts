import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  runRpcStartupTransaction,
  type RpcStartupTransaction
} from '../src/main/agent/engine/rpc/startup-transaction'
import type {
  RemoteExecResult,
  RemoteSshSession
} from '../src/main/agent/wrappers/remote-ssh-session'

function execWithInput(
  command: string,
  input: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<RemoteExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command], { env, stdio: ['pipe', 'pipe', 'pipe'] })
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

function session(
  onCommand: () => void,
  env?: NodeJS.ProcessEnv
): Pick<RemoteSshSession, 'execWithInput'> {
  return {
    execWithInput(command, input) {
      onCommand()
      return execWithInput(command, input, env)
    }
  }
}

test('prepared startup validates markers and atomically publishes exact private files in one command', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'phi-startup-transaction-')))
  try {
    await chmod(root, 0o700)
    const projectRoot = join(root, 'project')
    const ompDirectory = join(root, 'omp', '18.10.3')
    const extensionDirectory = join(root, 'extensions', 'a'.repeat(64))
    const generationDirectory = join(root, 'rpc-sessions', 'generation-123456')
    await mkdir(projectRoot, { recursive: true, mode: 0o700 })
    await mkdir(ompDirectory, { recursive: true, mode: 0o700 })
    await mkdir(extensionDirectory, { recursive: true, mode: 0o700 })
    for (const path of [join(root, 'omp'), join(root, 'extensions')]) await chmod(path, 0o700)
    const ompMarker = Buffer.from(
      JSON.stringify({
        schema: 1,
        kind: 'remote-omp',
        version: '18.10.3',
        sha256: 'b'.repeat(64)
      }) + '\n'
    )
    const extensionMarker = Buffer.from(
      JSON.stringify({ schema: 1, kind: 'phi-extension', contentHash: 'a'.repeat(64) }) + '\n'
    )
    await writeFile(join(ompDirectory, '.phi-ready.json'), ompMarker, { mode: 0o600 })
    await writeFile(join(extensionDirectory, '.phi-ready.json'), extensionMarker, { mode: 0o600 })

    const config = Buffer.from('{"schema":1}\n')
    const transaction: RpcStartupTransaction = {
      runtimeRoot: root,
      projectRoot,
      markers: [
        {
          item: 'omp',
          managedRoot: join(root, 'omp'),
          directory: ompDirectory,
          path: join(ompDirectory, '.phi-ready.json'),
          bytes: ompMarker
        },
        {
          item: 'extension',
          managedRoot: join(root, 'extensions'),
          directory: extensionDirectory,
          path: join(extensionDirectory, '.phi-ready.json'),
          bytes: extensionMarker
        }
      ],
      directories: [
        { path: join(root, 'rpc-sessions') },
        { path: generationDirectory, ifAbsent: true },
        { path: join(generationDirectory, 'home') }
      ],
      files: [
        {
          item: 'bootstrap-config',
          path: join(generationDirectory, 'config.json'),
          bytes: config,
          mode: 0o600,
          ifAbsent: true
        }
      ]
    }
    let commands = 0
    const execution = await runRpcStartupTransaction(
      session(() => commands++),
      transaction
    )

    assert.equal(commands, 1)
    assert.deepEqual(execution.result, {
      status: 'ready',
      checks: [{ item: 'project_plugin_guard', status: 'skipped' }],
      markers: [
        { item: 'omp', status: 'ready' },
        { item: 'extension', status: 'ready' }
      ]
    })
    assert.deepEqual(await readFile(join(generationDirectory, 'config.json')), config)
    assert.equal((await stat(join(generationDirectory, 'config.json'))).mode & 0o777, 0o600)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

async function markerFixture(): Promise<{
  root: string
  projectRoot: string
  managedRoot: string
  directory: string
  marker: string
  expected: Buffer
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'phi-startup-marker-')))
  await chmod(root, 0o700)
  const projectRoot = join(root, 'project')
  const managedRoot = join(root, 'managed')
  const directory = join(managedRoot, 'version')
  await mkdir(projectRoot, { mode: 0o700 })
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(managedRoot, 0o700)
  const marker = join(directory, '.phi-ready.json')
  const expected = Buffer.from('{"schema":1,"kind":"fixture"}')
  await writeFile(marker, expected, { mode: 0o600 })
  return { root, projectRoot, managedRoot, directory, marker, expected }
}

function markerTransaction(
  fixture: Awaited<ReturnType<typeof markerFixture>>,
  generation = 'generation'
): RpcStartupTransaction {
  return {
    runtimeRoot: fixture.root,
    projectRoot: fixture.projectRoot,
    markers: [
      {
        item: 'fixture',
        managedRoot: fixture.managedRoot,
        directory: fixture.directory,
        path: fixture.marker,
        bytes: fixture.expected
      }
    ],
    directories: [
      { path: join(fixture.root, 'rpc-sessions') },
      { path: join(fixture.root, 'rpc-sessions', generation), ifAbsent: true }
    ],
    files: [
      {
        item: `config-${generation}`,
        path: join(fixture.root, 'rpc-sessions', generation, 'config.json'),
        bytes: Buffer.from(generation),
        mode: 0o600,
        ifAbsent: true
      }
    ]
  }
}

for (const scenario of [
  {
    name: 'missing marker',
    reason: 'missing_marker',
    mutate: async (fixture: Awaited<ReturnType<typeof markerFixture>>) => rm(fixture.marker)
  },
  {
    name: 'wrong marker hash',
    reason: 'wrong_hash',
    mutate: async (fixture: Awaited<ReturnType<typeof markerFixture>>) =>
      writeFile(fixture.marker, 'wrong', { mode: 0o600 })
  },
  {
    name: 'symlink marker',
    reason: 'symlink_marker',
    mutate: async (fixture: Awaited<ReturnType<typeof markerFixture>>) => {
      const target = join(fixture.root, 'marker-target')
      await writeFile(target, fixture.expected, { mode: 0o600 })
      await rm(fixture.marker)
      await symlink(target, fixture.marker)
    }
  },
  {
    name: 'wrong marker mode',
    reason: 'wrong_mode',
    mutate: async (fixture: Awaited<ReturnType<typeof markerFixture>>) =>
      chmod(fixture.marker, 0o644)
  },
  {
    name: 'hardlinked marker',
    reason: 'linked_marker',
    mutate: async (fixture: Awaited<ReturnType<typeof markerFixture>>) =>
      link(fixture.marker, join(fixture.root, 'marker-link'))
  }
] as const) {
  test(`${scenario.name} requests repair and publishes no generation`, async () => {
    const fixture = await markerFixture()
    try {
      await scenario.mutate(fixture)
      const execution = await runRpcStartupTransaction(
        session(() => undefined),
        markerTransaction(fixture)
      )
      assert.equal(execution.result.status, 'repair')
      assert.deepEqual(execution.result.markers, [
        { item: 'fixture', status: 'repair', reason: scenario.reason }
      ])
      await assert.rejects(stat(join(fixture.root, 'rpc-sessions', 'generation')), {
        code: 'ENOENT'
      })
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })
}

test('unsafe marker directory component is refused before publication', async () => {
  const fixture = await markerFixture()
  try {
    const realDirectory = join(fixture.managedRoot, 'real-version')
    await mkdir(realDirectory, { mode: 0o700 })
    await writeFile(join(realDirectory, '.phi-ready.json'), fixture.expected, { mode: 0o600 })
    await rm(fixture.directory, { recursive: true })
    await symlink(realDirectory, fixture.directory)
    const execution = await runRpcStartupTransaction(
      session(() => undefined),
      markerTransaction(fixture)
    )
    assert.deepEqual(execution.result.markers, [
      { item: 'fixture', status: 'repair', reason: 'unsafe_directory' }
    ])
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('startup refuses a symlinked shared native directory before publishing a generation', async () => {
  const fixture = await markerFixture()
  try {
    const natives = join(fixture.root, 'omp-natives')
    const outside = join(fixture.root, 'outside-natives')
    await mkdir(outside, { mode: 0o700 })
    await symlink(outside, natives)
    const base = markerTransaction(fixture)

    await assert.rejects(
      runRpcStartupTransaction(
        session(() => undefined),
        {
          ...base,
          directories: [{ path: natives }, ...base.directories]
        }
      ),
      /PHI_STARTUP:SYMBOLIC_DIRECTORY/u
    )
    assert.deepEqual(await readdir(outside), [])
    await assert.rejects(stat(join(fixture.root, 'rpc-sessions', 'generation')), {
      code: 'ENOENT'
    })
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('startup refuses a shared native directory reported as owned by another user', async () => {
  const fixture = await markerFixture()
  try {
    const natives = join(fixture.root, 'omp-natives')
    await mkdir(natives, { mode: 0o700 })
    const shimDirectory = join(fixture.root, 'stat-shim')
    await mkdir(shimDirectory, { mode: 0o700 })
    await writeFile(
      join(shimDirectory, 'stat'),
      `#!/bin/sh
last=
owner=
for arg do
  last=$arg
  [ "$arg" != %u ] || owner=1
done
if [ "$owner" = 1 ] && [ "$last" = "$PHI_FOREIGN_PATH" ]; then
  printf '4294967294\\n'
  exit 0
fi
exec /usr/bin/stat "$@"
`,
      { mode: 0o700 }
    )
    const base = markerTransaction(fixture)
    const env = {
      ...process.env,
      PATH: `${shimDirectory}:${process.env.PATH ?? ''}`,
      PHI_FOREIGN_PATH: natives
    }

    await assert.rejects(
      runRpcStartupTransaction(
        session(() => undefined, env),
        {
          ...base,
          directories: [{ path: natives }, ...base.directories]
        }
      ),
      /PHI_STARTUP:DIRECTORY_OWNER/u
    )
    await assert.rejects(stat(join(fixture.root, 'rpc-sessions', 'generation')), {
      code: 'ENOENT'
    })
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('concurrent startup transactions publish isolated generations without temporary leftovers', async () => {
  const fixture = await markerFixture()
  try {
    const [first, second] = await Promise.all([
      runRpcStartupTransaction(
        session(() => undefined),
        markerTransaction(fixture, 'first')
      ),
      runRpcStartupTransaction(
        session(() => undefined),
        markerTransaction(fixture, 'second')
      )
    ])
    assert.equal(first.result.status, 'ready')
    assert.equal(second.result.status, 'ready')
    assert.equal(
      await readFile(join(fixture.root, 'rpc-sessions', 'first', 'config.json'), 'utf8'),
      'first'
    )
    assert.equal(
      await readFile(join(fixture.root, 'rpc-sessions', 'second', 'config.json'), 'utf8'),
      'second'
    )
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('startup result must report every requested marker exactly once', async () => {
  const fixture = await markerFixture()
  try {
    await assert.rejects(
      runRpcStartupTransaction(
        {
          async execWithInput() {
            return {
              stdout:
                'PHI_RPC_STARTUP_RESULT_V1\nCHECK\tproject_plugin_guard\tskipped\nSTATUS\tready\nPHI_RPC_STARTUP_RESULT_END\n',
              stderr: '',
              code: 0,
              signal: null
            }
          }
        },
        markerTransaction(fixture)
      ),
      /Inconsistent remote RPC startup result/
    )
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})
