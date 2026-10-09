import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  buildHelper,
  helperBuildFingerprint,
  HELPER_TARGETS,
  parseHelperBuildArgs
} from '../scripts/build-helper.mjs'
import { goToolchainEnvironment } from '../scripts/helper-toolchain.mjs'

function createFixture(): {
  root: string
  calls: { args: string[]; env: Record<string, string> }[]
  goRunner: (args: string[], options: { env: Record<string, string>; cwd: string }) => void
  manifestPath: string
  outputPath: (target?: string) => string
  cleanup: () => void
} {
  const root = mkdtempSync(path.join(tmpdir(), 'phi-helper-cache-'))
  const calls: { args: string[]; env: Record<string, string> }[] = []
  mkdirSync(path.join(root, 'helper'))
  writeFileSync(path.join(root, 'helper', 'VERSION'), '0.1.0\n')
  writeFileSync(path.join(root, 'helper', 'go.mod'), 'module phi-helper\n\ngo 1.22\n')
  writeFileSync(path.join(root, 'helper', 'main.go'), 'package main\nfunc main() {}\n')
  return {
    root,
    calls,
    goRunner: (args, options): void => {
      assert.equal(options.cwd, path.join(root, 'helper'))
      assert.equal(options.env.CGO_ENABLED, '0')
      assert.equal(options.env.GOOS, 'linux')
      assert.deepEqual(args.slice(0, 4), ['build', '-trimpath', '-ldflags', '-s -w'])
      calls.push({ args, env: options.env })
      writeFileSync(
        args[args.indexOf('-o') + 1],
        `static ${options.env.GOARCH} helper ${calls.length}`
      )
    },
    manifestPath: path.join(root, 'resources', 'remote-helper', 'manifest.json'),
    outputPath: (target = 'linux-amd64'): string =>
      path.join(root, 'resources', 'remote-helper', '0.1.0', target, 'phi-helper'),
    cleanup: (): void => rmSync(root, { force: true, recursive: true })
  }
}

test('unchanged helper builds reuse checked artifacts without invoking Go again', () => {
  const fixture = createFixture()
  try {
    const first = buildHelper(fixture)
    const files = [fixture.manifestPath, fixture.outputPath(), fixture.outputPath('linux-arm64')]
    for (const file of files) utimesSync(file, 1, 1)
    const second = buildHelper({
      root: fixture.root,
      goRunner: (): never => {
        assert.fail('warm cache must not invoke Go or toolchain preparation')
      }
    })
    assert.deepEqual(second, first)
    assert.equal(fixture.calls.length, 2, 'only the initial two release targets invoke Go')
    for (const file of files) assert.equal(statSync(file).mtimeMs, 1_000)
  } finally {
    fixture.cleanup()
  }
})

test('helper builds pin portable ISA settings despite inherited Go environment changes', () => {
  const fixture = createFixture()
  const keys = ['GOAMD64', 'GOARM64', 'GOEXPERIMENT'] as const
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  try {
    process.env.GOAMD64 = 'v4'
    process.env.GOARM64 = 'v9.5,lse'
    process.env.GOEXPERIMENT = 'arenas'
    const first = buildHelper({
      ...fixture,
      goRunner: (args: string[], options: { env: Record<string, string>; cwd: string }): void => {
        const actual = goToolchainEnvironment({ ...process.env, ...options.env }, '/fixture/go')
        assert.equal(actual.GOAMD64, 'v1')
        assert.equal(actual.GOARM64, 'v8.0')
        assert.equal(actual.GOEXPERIMENT, '')
        fixture.goRunner(args, options)
      }
    })
    process.env.GOAMD64 = 'v2'
    process.env.GOARM64 = 'v8.6'
    process.env.GOEXPERIMENT = 'regabiwrappers'
    const second = buildHelper({
      root: fixture.root,
      goRunner: (): never =>
        assert.fail('irrelevant user settings do not invalidate portable artifacts')
    })
    assert.deepEqual(second, first)
    assert.equal(fixture.calls.length, 2)
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
    fixture.cleanup()
  }
})

test('selected-target builds compile one architecture and retain the other checked artifact', () => {
  const fixture = createFixture()
  try {
    const first = buildHelper({ ...fixture, target: 'linux-amd64' })
    assert.deepEqual(Object.keys(first.platforms), ['linux-amd64'])
    assert.equal(fixture.calls.length, 1)
    assert.equal(fixture.calls[0].env.GOARCH, 'amd64')
    utimesSync(fixture.outputPath(), 1, 1)
    const second = buildHelper({ ...fixture, target: 'linux-arm64' })
    assert.deepEqual(Object.keys(second.platforms), ['linux-amd64', 'linux-arm64'])
    assert.deepEqual(second.platforms['linux-amd64'], first.platforms['linux-amd64'])
    assert.equal(fixture.calls.length, 2)
    assert.equal(fixture.calls[1].env.GOARCH, 'arm64')
    assert.equal(statSync(fixture.outputPath()).mtimeMs, 1_000)
    assert.notEqual(
      second.platforms['linux-amd64'].fingerprint,
      second.platforms['linux-arm64'].fingerprint
    )
  } finally {
    fixture.cleanup()
  }
})

const invalidations: [string, (fixture: ReturnType<typeof createFixture>) => void][] = [
  ['missing manifest', ({ manifestPath }): void => rmSync(manifestPath)],
  ['corrupt manifest', ({ manifestPath }): void => writeFileSync(manifestPath, '{')],
  ['missing artifact', ({ outputPath }): void => rmSync(outputPath())],
  [
    'changed artifact size',
    ({ outputPath }): void => writeFileSync(outputPath(), 'different-sized binary')
  ],
  [
    'same-size artifact corruption',
    ({ outputPath }): void => {
      const size = statSync(outputPath()).size
      writeFileSync(outputPath(), 'x'.repeat(size))
    }
  ],
  [
    'obsolete fingerprint',
    ({ manifestPath }): void => {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      manifest.platforms['linux-amd64'].fingerprint = 'old source/toolchain/flags'
      writeFileSync(manifestPath, JSON.stringify(manifest))
    }
  ],
  [
    'legacy manifest without fingerprint',
    ({ manifestPath }): void => {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      delete manifest.platforms['linux-amd64'].fingerprint
      writeFileSync(manifestPath, JSON.stringify(manifest))
    }
  ],
  [
    'invalid artifact path',
    ({ manifestPath }): void => {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      manifest.platforms['linux-amd64'].path = '../untrusted'
      writeFileSync(manifestPath, JSON.stringify(manifest))
    }
  ],
  [
    'wrong checksum',
    ({ manifestPath }): void => {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      manifest.platforms['linux-amd64'].sha256 = '0'.repeat(64)
      writeFileSync(manifestPath, JSON.stringify(manifest))
    }
  ]
]

for (const [reason, invalidate] of invalidations) {
  test(`helper cache rebuilds the selected target after ${reason}`, () => {
    const fixture = createFixture()
    try {
      buildHelper({ ...fixture, target: 'linux-amd64' })
      invalidate(fixture)
      const manifest = buildHelper({ ...fixture, target: 'linux-amd64' })
      assert.equal(fixture.calls.length, 2)
      assert.equal(manifest.platforms['linux-amd64'].size, statSync(fixture.outputPath()).size)
      buildHelper({ ...fixture, target: 'linux-amd64' })
      assert.equal(fixture.calls.length, 2, 'rebuilt output is reusable')
    } finally {
      fixture.cleanup()
    }
  })
}

for (const file of ['main.go', 'go.mod', 'go.sum', 'VERSION', 'nested/handler.go']) {
  test(`helper source fingerprint invalidates when ${file} changes`, () => {
    const fixture = createFixture()
    try {
      buildHelper(fixture)
      const input = path.join(fixture.root, 'helper', file)
      mkdirSync(path.dirname(input), { recursive: true })
      writeFileSync(input, file === 'VERSION' ? '0.2.0\n' : 'changed source contents\n')
      const manifest = buildHelper({ ...fixture, target: 'linux-amd64' })
      assert.equal(fixture.calls.length, 3, 'only requested target rebuilds')
      assert.deepEqual(
        Object.keys(manifest.platforms),
        ['linux-amd64'],
        'stale other target is omitted'
      )
      assert.equal(manifest.version, file === 'VERSION' ? '0.2.0' : '0.1.0')
    } finally {
      fixture.cleanup()
    }
  })
}

test('source file deletion invalidates but unrelated documentation edits do not', () => {
  const fixture = createFixture()
  try {
    const added = path.join(fixture.root, 'helper', 'extra.go')
    writeFileSync(added, 'package main\n')
    buildHelper({ ...fixture, target: 'linux-amd64' })
    writeFileSync(path.join(fixture.root, 'helper', 'README.md'), 'new instructions')
    buildHelper({ ...fixture, target: 'linux-amd64' })
    assert.equal(fixture.calls.length, 1)
    rmSync(added)
    buildHelper({ ...fixture, target: 'linux-amd64' })
    assert.equal(fixture.calls.length, 2)
  } finally {
    fixture.cleanup()
  }
})

test('manifest publication preserves another target completed during compilation', () => {
  const fixture = createFixture()
  try {
    const manifest = buildHelper({
      ...fixture,
      target: 'linux-amd64',
      goRunner: (args: string[], options: { env: Record<string, string>; cwd: string }): void => {
        buildHelper({ ...fixture, target: 'linux-arm64' })
        fixture.goRunner(args, options)
      }
    })
    assert.deepEqual(Object.keys(manifest.platforms), ['linux-amd64', 'linux-arm64'])
    assert.equal(fixture.calls.length, 2)
    buildHelper(fixture)
    assert.equal(fixture.calls.length, 2)
  } finally {
    fixture.cleanup()
  }
})

test(
  'two processes retain both targets when one waits at manifest publication',
  { timeout: 20_000 },
  async () => {
    const fixture = createFixture()
    const children: ReturnType<typeof spawn>[] = []
    const completions: Promise<{ code: number | null; output: string }>[] = []
    try {
      const script = path.join(fixture.root, 'publisher.mjs')
      writeFileSync(
        script,
        `import fs from 'node:fs'
import path from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
const [root, target] = process.argv.slice(2)
const manifest = path.join(root, 'resources', 'remote-helper', 'manifest.json')
const cell = new Int32Array(new SharedArrayBuffer(4))
const rename = fs.renameSync
fs.renameSync = (source, destination) => {
  if (target === 'linux-amd64' && destination === manifest) {
    fs.writeFileSync(path.join(root, 'first-publishing'), '')
    const deadline = Date.now() + 10000
    while (!fs.existsSync(path.join(root, 'release-first'))) {
      if (Date.now() >= deadline) throw new Error('fixture publication barrier timed out')
      Atomics.wait(cell, 0, 0, 10)
    }
  }
  if (target === 'linux-arm64' && destination === manifest) {
    fs.writeFileSync(path.join(root, 'second-publishing'), '')
  }
  try {
    return rename(source, destination)
  } catch (error) {
    if (target === 'linux-arm64' && destination === manifest + '.lock') {
      fs.writeFileSync(path.join(root, 'second-waiting'), '')
    }
    throw error
  }
}
syncBuiltinESMExports()
const { buildHelper } = await import(${JSON.stringify(new URL('../scripts/build-helper.mjs', import.meta.url).href)})
buildHelper({ root, target, goRunner(args, options) {
  fs.writeFileSync(args[args.indexOf('-o') + 1], 'static ' + options.env.GOARCH + ' helper')
} })
`
      )
      const launch = (target: string): void => {
        const child = spawn(process.execPath, [script, fixture.root, target], { stdio: 'pipe' })
        children.push(child)
        completions.push(
          new Promise((resolve, reject) => {
            let output = ''
            child.stdout?.on('data', (chunk): void => {
              output += chunk.toString()
            })
            child.stderr?.on('data', (chunk): void => {
              output += chunk.toString()
            })
            child.once('error', reject)
            child.once('close', (code): void => resolve({ code, output }))
          })
        )
      }
      const waitFor = async (condition: () => boolean): Promise<void> => {
        const deadline = Date.now() + 8_000
        while (!condition()) {
          assert.ok(Date.now() < deadline, 'child process did not reach the publication barrier')
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
      }
      launch('linux-amd64')
      await waitFor(() => existsSync(path.join(fixture.root, 'first-publishing')))
      launch('linux-arm64')
      await waitFor(() =>
        ['second-waiting', 'second-publishing'].some((file) =>
          existsSync(path.join(fixture.root, file))
        )
      )
      writeFileSync(path.join(fixture.root, 'release-first'), '')
      for (const result of await Promise.all(completions))
        assert.equal(result.code, 0, result.output)
      const manifest = JSON.parse(readFileSync(fixture.manifestPath, 'utf8'))
      assert.deepEqual(Object.keys(manifest.platforms), ['linux-amd64', 'linux-arm64'])
      buildHelper({
        root: fixture.root,
        goRunner: (): never => assert.fail('both independently compiled targets must be reusable')
      })
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill('SIGKILL')
      await Promise.allSettled(completions)
      fixture.cleanup()
    }
  }
)

test('publication recovers a killed owner but never removes a live or unknown lock', () => {
  const fixture = createFixture()
  try {
    const lock = `${fixture.manifestPath}.lock`
    mkdirSync(lock, { recursive: true })
    const deadOwner = spawnSync(process.execPath, ['-e', 'process.exit(0)'])
    assert.equal(deadOwner.status, 0)
    const deadName = `owner-${deadOwner.pid}-${randomUUID()}`
    writeFileSync(path.join(lock, deadName), '')
    buildHelper({ ...fixture, target: 'linux-amd64', lockTimeoutMs: 200 })
    assert.equal(existsSync(lock), false)
    assert.equal(fixture.calls.length, 1)

    mkdirSync(lock)
    const liveName = `owner-${process.pid}-${randomUUID()}`
    writeFileSync(path.join(lock, liveName), '')
    const manifest = readFileSync(fixture.manifestPath, 'utf8')
    assert.throws(
      () => buildHelper({ ...fixture, target: 'linux-amd64', lockTimeoutMs: 50 }),
      /timed out waiting/
    )
    assert.equal(existsSync(path.join(lock, liveName)), true)
    assert.equal(readFileSync(fixture.manifestPath, 'utf8'), manifest)
    assert.equal(fixture.calls.length, 1, 'a busy publisher does not force recompilation')
    rmSync(lock, { recursive: true })

    mkdirSync(lock)
    writeFileSync(path.join(lock, 'unrelated-lock-owner'), '')
    assert.throws(
      () => buildHelper({ ...fixture, target: 'linux-amd64', lockTimeoutMs: 20 }),
      /timed out waiting/
    )
    assert.equal(existsSync(path.join(lock, 'unrelated-lock-owner')), true)
    assert.deepEqual(
      readdirSync(path.dirname(lock)).filter((file) => file.startsWith('manifest.json.lock.')),
      [],
      'waiting candidates are cleaned up'
    )
  } finally {
    fixture.cleanup()
  }
})

test('failed publication removes its partial manifest and releases its lock', () => {
  const fixture = createFixture()
  try {
    mkdirSync(fixture.manifestPath, { recursive: true })
    assert.throws(() => buildHelper({ ...fixture, target: 'linux-amd64' }), /EISDIR|EPERM/)
    assert.deepEqual(readdirSync(path.dirname(fixture.manifestPath)).sort(), [
      '0.1.0',
      'manifest.json'
    ])
    assert.equal(statSync(fixture.manifestPath).isDirectory(), true)
  } finally {
    fixture.cleanup()
  }
})

test('failed compilation retains the last artifact and manifest', () => {
  const fixture = createFixture()
  try {
    buildHelper({ ...fixture, target: 'linux-amd64' })
    const manifest = readFileSync(fixture.manifestPath, 'utf8')
    const artifact = readFileSync(fixture.outputPath(), 'utf8')
    writeFileSync(path.join(fixture.root, 'helper', 'main.go'), 'changed source\n')
    assert.throws(
      () =>
        buildHelper({
          root: fixture.root,
          target: 'linux-amd64',
          goRunner: (args: string[]): never => {
            writeFileSync(args[args.indexOf('-o') + 1], 'incomplete binary')
            throw new Error('compiler failed')
          }
        }),
      /compiler failed/
    )
    assert.equal(readFileSync(fixture.manifestPath, 'utf8'), manifest)
    assert.equal(readFileSync(fixture.outputPath(), 'utf8'), artifact)
  } finally {
    fixture.cleanup()
  }
})

test('fingerprints distinguish architecture and the helper build CLI rejects unsupported targets', () => {
  const fixture = createFixture()
  try {
    assert.notEqual(
      helperBuildFingerprint(fixture.root, HELPER_TARGETS[0]),
      helperBuildFingerprint(fixture.root, HELPER_TARGETS[1])
    )
    assert.deepEqual(parseHelperBuildArgs([]), {})
    assert.deepEqual(parseHelperBuildArgs(['--target', 'linux-amd64']), { target: 'linux-amd64' })
    assert.deepEqual(parseHelperBuildArgs(['--target', 'linux-arm64']), { target: 'linux-arm64' })
    for (const args of [
      ['--target'],
      ['--target', 'darwin-arm64'],
      ['linux-amd64'],
      ['--target', 'linux-amd64', '--target', 'linux-arm64'],
      ['--target=linux-amd64'],
      ['--unknown', 'linux-amd64']
    ]) {
      assert.throws(() => parseHelperBuildArgs(args), /build-helper:/)
    }
    assert.throws(() => buildHelper({ ...fixture, target: 'linux-x64' }), /unsupported target/)
    assert.equal(fixture.calls.length, 0)
  } finally {
    fixture.cleanup()
  }
})
