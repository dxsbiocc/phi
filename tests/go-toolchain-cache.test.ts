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
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ensureGoToolchain, GO_RELEASE, goBinaryPath } from '../scripts/runtime/fetch-go.mjs'

function createFixture(): {
  root: string
  cacheRoot: string
  binary: string
  archive: string
  calls: string[]
  options: {
    cacheRoot: string
    platform: string
    arch: string
    verifyArchive: (file: string, hash: string) => boolean
    versionMatches: (file: string) => boolean
    download: (release: { sha256: string }, file: string) => void
    extract: (archive: string, cacheRoot: string) => void
  }
  cleanup: () => void
} {
  const root = mkdtempSync(path.join(tmpdir(), 'phi-go-install-'))
  const cacheRoot = path.join(root, 'cache')
  const release = GO_RELEASE.platforms['linux-amd64']
  const binary = goBinaryPath(cacheRoot)
  const archive = path.join(cacheRoot, path.basename(new URL(release.url).pathname))
  const calls: string[] = []
  return {
    root,
    cacheRoot,
    binary,
    archive,
    calls,
    options: {
      cacheRoot,
      platform: 'linux',
      arch: 'x64',
      verifyArchive: (file, hash): boolean => {
        assert.equal(hash, release.sha256)
        return existsSync(file) && readFileSync(file, 'utf8') === 'verified archive'
      },
      versionMatches: (file): boolean =>
        existsSync(file) && readFileSync(file, 'utf8') === `go${GO_RELEASE.version}`,
      download: (manifest, file): void => {
        assert.equal(manifest.sha256, release.sha256)
        calls.push('download')
        writeFileSync(file, 'verified archive')
      },
      extract: (file, destination): void => {
        assert.equal(file, archive)
        assert.equal(destination, cacheRoot)
        calls.push('extract')
        mkdirSync(path.dirname(binary), { recursive: true })
        writeFileSync(binary, `go${GO_RELEASE.version}`)
      }
    },
    cleanup: (): void => rmSync(root, { force: true, recursive: true })
  }
}

test('Go preparation reuses a verified install without acquiring a busy installation lock', () => {
  const fixture = createFixture()
  try {
    assert.equal(ensureGoToolchain(fixture.options), fixture.binary)
    assert.deepEqual(fixture.calls, ['download', 'extract'])
    const lock = path.join(fixture.cacheRoot, 'install.lock')
    mkdirSync(lock)
    const owner = `owner-${process.pid}-${randomUUID()}`
    writeFileSync(path.join(lock, owner), '')
    assert.equal(ensureGoToolchain(fixture.options), fixture.binary)
    assert.deepEqual(fixture.calls, ['download', 'extract'])
    assert.equal(existsSync(path.join(lock, owner)), true)
  } finally {
    fixture.cleanup()
  }
})

test('cold preparation recovers a dead installer and bounds waiting for a live or unknown owner', () => {
  const fixture = createFixture()
  try {
    const lock = path.join(fixture.cacheRoot, 'install.lock')
    mkdirSync(lock, { recursive: true })
    const deadOwner = spawnSync(process.execPath, ['-e', 'process.exit(0)'])
    assert.equal(deadOwner.status, 0)
    writeFileSync(path.join(lock, `owner-${deadOwner.pid}-${randomUUID()}`), '')
    assert.equal(ensureGoToolchain({ ...fixture.options, lockTimeoutMs: 200 }), fixture.binary)
    assert.equal(existsSync(lock), false)

    rmSync(fixture.binary)
    mkdirSync(lock)
    const liveOwner = `owner-${process.pid}-${randomUUID()}`
    writeFileSync(path.join(lock, liveOwner), '')
    assert.throws(
      () => ensureGoToolchain({ ...fixture.options, lockTimeoutMs: 30 }),
      /timed out waiting for Go toolchain installation/
    )
    assert.equal(existsSync(path.join(lock, liveOwner)), true)
    assert.deepEqual(fixture.calls, ['download', 'extract'])
    assert.deepEqual(
      readdirSync(fixture.cacheRoot).filter((name) => name.startsWith('install.lock.')),
      []
    )
    rmSync(lock, { recursive: true })
    mkdirSync(lock)
    writeFileSync(path.join(lock, 'unknown-owner'), '')
    assert.throws(
      () => ensureGoToolchain({ ...fixture.options, lockTimeoutMs: 30 }),
      /timed out waiting/
    )
    assert.equal(existsSync(path.join(lock, 'unknown-owner')), true)
  } finally {
    fixture.cleanup()
  }
})

test('failed installation releases its lock and can be retried with the verified archive', () => {
  const fixture = createFixture()
  try {
    assert.throws(
      () =>
        ensureGoToolchain({
          ...fixture.options,
          extract: (): never => {
            throw new Error('fixture extraction failed')
          }
        }),
      /fixture extraction failed/
    )
    assert.equal(existsSync(path.join(fixture.cacheRoot, 'install.lock')), false)
    assert.deepEqual(
      readdirSync(fixture.cacheRoot).filter((name) => name.startsWith('install.lock.')),
      []
    )
    assert.equal(ensureGoToolchain(fixture.options), fixture.binary)
    assert.deepEqual(fixture.calls, ['download', 'extract'])
  } finally {
    fixture.cleanup()
  }
})

test(
  'two cold preparation processes do not replace an install while its compiler starts',
  { timeout: 20_000 },
  async () => {
    const fixture = createFixture()
    const children: ReturnType<typeof spawn>[] = []
    const completions: Promise<{ code: number | null; output: string }>[] = []
    try {
      const script = path.join(fixture.root, 'installer.mjs')
      writeFileSync(
        script,
        `import fs from 'node:fs'
import path from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
const [root, role] = process.argv.slice(2)
const cacheRoot = path.join(root, 'cache')
const binary = path.join(cacheRoot, 'go', 'bin', process.platform === 'win32' ? 'go.exe' : 'go')
const cell = new Int32Array(new SharedArrayBuffer(4))
const waitFor = (name) => {
  const deadline = Date.now() + 10000
  while (!fs.existsSync(path.join(root, name))) {
    if (Date.now() >= deadline) throw new Error('fixture installation barrier timed out')
    Atomics.wait(cell, 0, 0, 10)
  }
}
const rename = fs.renameSync
fs.renameSync = (source, destination) => {
  try { return rename(source, destination) }
  catch (error) {
    if (role === 'second' && destination === path.join(cacheRoot, 'install.lock')) {
      fs.writeFileSync(path.join(root, 'second-waiting'), '')
    }
    throw error
  }
}
syncBuiltinESMExports()
const { ensureGoToolchain } = await import(${JSON.stringify(new URL('../scripts/runtime/fetch-go.mjs', import.meta.url).href)})
ensureGoToolchain({
  cacheRoot, platform: 'linux', arch: 'x64',
  verifyArchive(file) { return fs.existsSync(file) && fs.readFileSync(file, 'utf8') === 'verified archive' },
  versionMatches(file) { return fs.existsSync(file) && fs.readFileSync(file, 'utf8').startsWith('pinned ') },
  download(release, file) { fs.writeFileSync(file, 'verified archive') },
  extract() {
    if (role === 'first') {
      fs.writeFileSync(path.join(root, 'first-extracting'), '')
      waitFor('allow-first-install')
    } else {
      fs.writeFileSync(path.join(root, 'second-extracting'), '')
      waitFor('first-compiler-started')
      fs.rmSync(path.join(cacheRoot, 'go'), { recursive: true, force: true })
    }
    fs.mkdirSync(path.dirname(binary), { recursive: true })
    fs.writeFileSync(binary, 'pinned ' + role)
  }
})
if (role === 'first') fs.writeFileSync(path.join(root, 'first-compiler-started'), '')
`
      )
      const launch = (role: string): void => {
        const child = spawn(process.execPath, [script, fixture.root, role], { stdio: 'pipe' })
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
          assert.ok(Date.now() < deadline, 'child process did not reach installation barrier')
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
      }
      launch('first')
      await waitFor(() => existsSync(path.join(fixture.root, 'first-extracting')))
      launch('second')
      await waitFor(() =>
        ['second-waiting', 'second-extracting'].some((name) =>
          existsSync(path.join(fixture.root, name))
        )
      )
      writeFileSync(path.join(fixture.root, 'allow-first-install'), '')
      for (const result of await Promise.all(completions))
        assert.equal(result.code, 0, result.output)
      assert.equal(readFileSync(fixture.binary, 'utf8'), 'pinned first')
      assert.equal(existsSync(path.join(fixture.root, 'second-extracting')), false)
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill('SIGKILL')
      await Promise.allSettled(completions)
      fixture.cleanup()
    }
  }
)
