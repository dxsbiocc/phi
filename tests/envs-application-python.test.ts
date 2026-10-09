import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

import { installPythonApplication } from '../src/main/agent/envs/applications/python'
import type {
  ApplicationInstallInput,
  PythonUvInstallation
} from '../src/main/agent/envs/applications/types'
import { currentPlatform } from '../src/main/agent/envs/platform'
import { createPythonWheelFixture } from './helpers/pythonWheelFixture'

const HASH = 'ab'.repeat(32)
const VALID_REQUIREMENTS = ['demo==1.2.3 \\', `    --hash=sha256:${HASH}`, ''].join('\n')

function digest(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

function script(path: string, source: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `#!${process.execPath}\n${source}`, { mode: 0o755 })
  chmodSync(path, 0o755)
}

function fixture(requirements = VALID_REQUIREMENTS): {
  input: ApplicationInstallInput
  installation: PythonUvInstallation
  calls: () => Array<{ tool: string; args: string[]; env: Record<string, string> }>
  clean: () => void
} {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'phi-python-application-')))
  const prefix = join(root, 'envs', 'test-python')
  const sourceDir = join(root, 'source')
  mkdirSync(sourceDir, { recursive: true })
  mkdirSync(join(prefix, 'bin'), { recursive: true })
  writeFileSync(join(sourceDir, 'requirements.lock'), requirements)
  const record = join(root, 'calls.jsonl')
  const common = `
const fs = require('node:fs')
const path = require('node:path')
const prefix = path.dirname(path.dirname(__filename))
fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({tool: path.basename(__filename), args: process.argv.slice(2), env: process.env}) + '\\n')
`
  script(
    join(prefix, 'bin', 'python'),
    `${common}
console.log(JSON.stringify({prefix, scripts: path.join(prefix, 'bin'), purelib: path.join(prefix, 'lib'), platlib: path.join(prefix, 'lib')}))
`
  )
  script(
    join(prefix, 'bin', 'uv'),
    `${common}
const args = process.argv.slice(2)
if (args.includes('--dry-run')) process.exit(0)
if (args.includes('sync') || args.includes('install')) {
  const modeFile = path.join(prefix, 'mode')
  const mode = fs.existsSync(modeFile) ? fs.readFileSync(modeFile, 'utf8') : ''
  if (mode === 'wait') {
    fs.writeFileSync(path.join(prefix, 'pid'), String(process.pid))
    console.error('Preparing wheel installation')
    setInterval(() => {}, 1000)
  } else if (mode === 'fail') {
    console.error('Hash mismatch')
    process.exitCode = 1
  } else if (mode === 'outside') {
    fs.symlinkSync(${JSON.stringify(process.execPath)}, path.join(prefix, 'bin', 'demo'))
  } else {
    fs.writeFileSync(path.join(prefix, 'bin', 'demo'), '#!/bin/sh\\necho installed\\n', {mode: 0o755})
  }
} else if (args.includes('check')) {
  if (fs.existsSync(path.join(prefix, 'incomplete'))) {
    console.error('demo requires missing dependency')
    process.exitCode = 1
  }
} else if (args.includes('list')) {
  console.log(JSON.stringify([{name: 'demo', version: '1.2.3'}]))
}
`
  )
  const installation: PythonUvInstallation = {
    backend: 'python-uv',
    requirements: './requirements.lock',
    requirementsSha256: digest(requirements),
    executable: 'demo'
  }
  return {
    input: { root, prefix, sourceDir, platform: currentPlatform(), installation },
    installation,
    calls: () =>
      existsSync(record)
        ? readFileSync(record, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
        : [],
    clean: () => rmSync(root, { recursive: true, force: true })
  }
}

test('Python installer requires managed Python and uv without host fallback', async () => {
  for (const missing of ['python', 'uv']) {
    const f = fixture()
    try {
      unlinkSync(join(f.input.prefix, 'bin', missing))
      await assert.rejects(
        installPythonApplication(f.input),
        /managed.*(Python|python|uv).*missing/i
      )
      assert.deepEqual(f.calls(), [])
    } finally {
      f.clean()
    }
  }
})

test('Python installer rejects tools that resolve outside the managed prefix', async () => {
  const f = fixture()
  try {
    unlinkSync(join(f.input.prefix, 'bin', 'uv'))
    symlinkSync(process.execPath, join(f.input.prefix, 'bin', 'uv'))
    await assert.rejects(installPythonApplication(f.input), /outside.*prefix/i)
    assert.deepEqual(f.calls(), [])
  } finally {
    f.clean()
  }
})

test('Python installer verifies the signed lock before tool execution and cache reuse', async () => {
  const f = fixture()
  try {
    await installPythonApplication(f.input)
    const count = f.calls().length
    writeFileSync(join(f.input.sourceDir, 'requirements.lock'), 'tampered')
    await assert.rejects(installPythonApplication(f.input), /sha256|digest|checksum/i)
    assert.equal(f.calls().length, count)
  } finally {
    f.clean()
  }
})

test('Python installer reuses a verified executable offline and repairs executable tampering', async () => {
  const f = fixture()
  try {
    const first = await installPythonApplication(f.input)
    const calls = f.calls().length
    assert.deepEqual(await installPythonApplication(f.input), first)
    assert.equal(f.calls().length, calls)
    writeFileSync(first.executable, '#!/bin/sh\necho tampered\n')
    await installPythonApplication(f.input)
    assert.ok(f.calls().length > calls)
    assert.match(readFileSync(first.executable, 'utf8'), /echo installed/)
  } finally {
    f.clean()
  }
})

test('Python installer rejects symlinked owned state and cache directories', async () => {
  for (const directory of ['.phi', 'cache']) {
    const f = fixture()
    try {
      const owned =
        directory === '.phi' ? join(f.input.prefix, '.phi') : join(f.input.root, 'cache')
      symlinkSync(f.input.sourceDir, owned)
      await assert.rejects(installPythonApplication(f.input), /regular directory|symlink/i)
      assert.deepEqual(f.calls(), [])
    } finally {
      f.clean()
    }
  }
})

test('Python installer rejects traversal and symlinked lock assets before execution', async () => {
  for (const mode of ['traversal', 'file-link', 'directory-link']) {
    const f = fixture()
    try {
      if (mode === 'traversal') f.installation.requirements = '../requirements.lock'
      if (mode === 'file-link') {
        const lock = join(f.input.sourceDir, 'requirements.lock')
        unlinkSync(lock)
        writeFileSync(join(f.input.root, 'outside.lock'), VALID_REQUIREMENTS)
        symlinkSync(join(f.input.root, 'outside.lock'), lock)
      }
      if (mode === 'directory-link') {
        symlinkSync(f.input.sourceDir, join(f.input.sourceDir, 'linked'))
        f.installation.requirements = './linked/requirements.lock'
      }
      await assert.rejects(installPythonApplication(f.input), /path|symlink|contained|relative/i)
      assert.deepEqual(f.calls(), [])
    } finally {
      f.clean()
    }
  }
})

test('Python installer rejects unpinned, unhashed, source and settings requirements', async () => {
  const invalid = [
    'demo>=1.2.3',
    'demo==1.2.*',
    'demo==1.2.3',
    `demo==1.2.3 --hash=md5:${'ab'.repeat(16)}`,
    `demo @ https://example.org/demo.tar.gz --hash=sha256:${HASH}`,
    `demo @ file:///tmp/demo.whl --hash=sha256:${HASH}`,
    `demo @ git+https://example.org/demo --hash=sha256:${HASH}`,
    `-e demo==1.2.3 --hash=sha256:${HASH}`,
    `-r ./other.txt\n${VALID_REQUIREMENTS}`,
    `--index-url https://evil.example/simple\n${VALID_REQUIREMENTS}`,
    `--find-links https://evil.example/wheels\n${VALID_REQUIREMENTS}`,
    `demo==1.2.3 --no-binary=:all: --hash=sha256:${HASH}`,
    `demo @ https://user:password@example.org/demo.whl --hash=sha256:${HASH}`
  ]
  for (const requirements of invalid) {
    const f = fixture(requirements)
    try {
      await assert.rejects(
        installPythonApplication(f.input),
        /requirements|hash|wheel|pinned|https/i
      )
      assert.deepEqual(f.calls(), [], requirements)
    } finally {
      f.clean()
    }
  }
})

test('Python installer accepts exact versions, markers and direct HTTPS wheel locks', async () => {
  const f = fixture(
    `# Generated complete application lock\n` +
      `demo[feature]==1.2.3 ; python_version >= '3.10' --hash=sha256:${HASH}\n` +
      `other @ https://example.org/other-1.0-py3-none-any.whl --hash=sha256:${HASH}\n`
  )
  try {
    const result = await installPythonApplication(f.input)
    assert.equal(result.backend, 'python-uv')
    assert.equal(result.executable, join(f.input.prefix, 'bin', 'demo'))
    assert.match(result.specSha256, /^[a-f0-9]{64}$/)
    assert.equal(result.artifacts[0].sha256, f.installation.requirementsSha256)
    assert.ok(existsSync(join(f.input.root, 'artifacts', result.artifacts[0].key)))
    assert.deepEqual(result.packages, [{ name: 'demo', version: '1.2.3' }])
  } finally {
    f.clean()
  }
})

test('Python installer uses hashed wheels with isolated settings and records installed versions', async () => {
  const f = fixture()
  const old = process.env.UV_INDEX_URL
  process.env.UV_INDEX_URL = 'https://untrusted.example/simple'
  try {
    const progress: string[] = []
    await installPythonApplication({
      ...f.input,
      onProgress: (event) => progress.push(event.phase)
    })
    const calls = f.calls()
    const sync = calls.find(
      (call) => call.args.includes('install') && !call.args.includes('--dry-run')
    )
    assert.ok(sync)
    assert.equal(sync.tool, 'uv')
    assert.ok(sync.args.includes('--require-hashes'))
    assert.equal(sync.args[sync.args.indexOf('--only-binary') + 1], ':all:')
    assert.equal(
      sync.args[sync.args.indexOf('--python') + 1],
      join(f.input.prefix, 'bin', 'python')
    )
    assert.ok(sync.args.includes('--no-config'))
    assert.ok(sync.args.includes('--no-python-downloads'))
    assert.equal(sync.env.UV_INDEX_URL, undefined)
    assert.equal(sync.env.PYTHONPATH, undefined)
    assert.equal(sync.env.UV_PYTHON_DOWNLOADS, 'never')
    assert.equal(sync.env.PYTHONNOUSERSITE, '1')
    assert.equal(sync.env.PATH, join(f.input.prefix, 'bin'))
    assert.ok(sync.env.HOME.startsWith(join(f.input.root, 'cache', 'test-python', 'applications')))
    assert.ok(
      sync.env.XDG_CONFIG_HOME.startsWith(
        join(f.input.root, 'cache', 'test-python', 'applications')
      )
    )
    assert.ok(sync.env.UV_CACHE_DIR.startsWith(f.input.root))
    assert.ok(calls.some((call) => call.args.includes('check')))
    const installed = JSON.parse(
      readFileSync(join(f.input.prefix, '.phi', 'python-uv', 'installed.json'), 'utf8')
    )
    assert.deepEqual(installed, [{ name: 'demo', version: '1.2.3' }])
    assert.ok(progress.includes('installing'))
  } finally {
    if (old === undefined) delete process.env.UV_INDEX_URL
    else process.env.UV_INDEX_URL = old
    f.clean()
  }
})

test('Python installer rejects Python installation paths outside its prefix', async () => {
  const f = fixture()
  try {
    script(
      join(f.input.prefix, 'bin', 'python'),
      `console.log(JSON.stringify({prefix: '/usr', scripts: '/usr/bin', purelib: '/usr/lib', platlib: '/usr/lib'}))`
    )
    await assert.rejects(installPythonApplication(f.input), /Python.*outside.*prefix/i)
    assert.deepEqual(f.calls(), [])
  } finally {
    f.clean()
  }
})

test('Python installer rejects an escaping installed executable and incomplete dependency closure', async () => {
  for (const mode of ['outside', 'incomplete', 'fail']) {
    const f = fixture()
    try {
      if (mode === 'incomplete') writeFileSync(join(f.input.prefix, 'incomplete'), '')
      else writeFileSync(join(f.input.prefix, 'mode'), mode)
      await assert.rejects(installPythonApplication(f.input), /outside|dependency|Hash mismatch/i)
      assert.equal(existsSync(join(f.input.prefix, '.phi', 'python-uv', 'installed.json')), false)
    } finally {
      f.clean()
    }
  }
})

test('Python installer cancellation stops the managed install process', async () => {
  const f = fixture()
  try {
    writeFileSync(join(f.input.prefix, 'mode'), 'wait')
    const controller = new AbortController()
    const installation = installPythonApplication({
      ...f.input,
      signal: controller.signal,
      onProgress: (event) => {
        if (event.message.includes('Preparing wheel')) controller.abort()
      }
    })
    await assert.rejects(installation, /cancel|abort/i)
    const pid = Number(readFileSync(join(f.input.prefix, 'pid'), 'utf8'))
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
    assert.equal(existsSync(join(f.input.prefix, '.phi', 'python-uv', 'installed.json')), false)
  } finally {
    f.clean()
  }
})

test('Python installer honors a pre-aborted operation before execution', async () => {
  const f = fixture()
  try {
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      installPythonApplication({ ...f.input, signal: controller.signal }),
      /cancel|abort/i
    )
    assert.deepEqual(f.calls(), [])
  } finally {
    f.clean()
  }
})

test('Python installer honors cancellation when reporting an offline cache hit', async () => {
  const f = fixture()
  try {
    await installPythonApplication(f.input)
    const count = f.calls().length
    const controller = new AbortController()
    await assert.rejects(
      installPythonApplication({
        ...f.input,
        signal: controller.signal,
        onProgress: (event) => {
          if (event.phase === 'reusing') controller.abort()
        }
      }),
      /abort/i
    )
    assert.equal(f.calls().length, count)
  } finally {
    f.clean()
  }
})

const integrationPython = process.env.PHI_TEST_MANAGED_PYTHON
const integrationUv = process.env.PHI_TEST_MANAGED_UV

test(
  'Python installer installs and launches a real hashed wheel and reuses it offline',
  {
    skip:
      process.env.PHI_RUNTIME_INTEGRATION !== '1' || !integrationPython || !integrationUv
        ? 'Set PHI_RUNTIME_INTEGRATION=1, PHI_TEST_MANAGED_PYTHON and PHI_TEST_MANAGED_UV'
        : false,
    timeout: 120_000
  },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'phi-python-wheel-'))
    const wheel = await createPythonWheelFixture(root)
    const certificate = process.env.SSL_CERT_FILE
    process.env.SSL_CERT_FILE = wheel.certificate
    let closed = false
    let incompleteWheel: Awaited<ReturnType<typeof createPythonWheelFixture>> | undefined
    try {
      const requirements = `phi-test-app @ ${wheel.url} --hash=sha256:${wheel.sha256}\n`
      const sourceDir = join(root, 'source')
      const prefix = join(root, 'envs', 'wheel')
      mkdirSync(sourceDir, { recursive: true })
      writeFileSync(join(sourceDir, 'requirements.lock'), requirements)
      cpSync(integrationPython!, prefix, {
        recursive: true,
        dereference: false,
        verbatimSymlinks: true
      })
      copyFileSync(integrationUv!, join(prefix, 'bin', 'uv'))
      chmodSync(join(prefix, 'bin', 'uv'), 0o755)
      const standardLibrary = spawnSync(
        join(prefix, 'bin', 'python'),
        ['-I', '-c', 'import sysconfig; print(sysconfig.get_path("stdlib"))'],
        { encoding: 'utf8' }
      )
      assert.equal(standardLibrary.status, 0, standardLibrary.stderr)
      assert.ok(realpathSync(standardLibrary.stdout.trim()).startsWith(`${realpathSync(prefix)}/`))
      // This disposable copy models Phi's private conda prefix, which does not use
      // the standalone uv installation's external-management marker.
      rmSync(join(standardLibrary.stdout.trim(), 'EXTERNALLY-MANAGED'), { force: true })
      const input: ApplicationInstallInput = {
        root,
        prefix,
        sourceDir,
        platform: currentPlatform(),
        installation: {
          backend: 'python-uv',
          requirements: './requirements.lock',
          requirementsSha256: digest(requirements),
          executable: 'phi-test-app'
        }
      }
      const result = await installPythonApplication(input)
      const launch = spawnSync(result.executable, [], { encoding: 'utf8' })
      assert.equal(launch.status, 0, launch.stderr)
      assert.match(launch.stdout, /Phi test wheel 1\.0\.0/)
      assert.ok(
        result.packages?.some((entry) => entry.name === 'phi-test-app' && entry.version === '1.0.0')
      )
      await wheel.close()
      closed = true
      // The backend may audit an installed environment offline without fresh resolution.
      const offline = await installPythonApplication(input)
      assert.equal(offline.executable, result.executable)
      // A runtime-provided dependency cannot satisfy an omitted application lock entry.
      const paths = spawnSync(
        join(prefix, 'bin', 'python'),
        ['-I', '-c', 'import sysconfig; print(sysconfig.get_path("purelib"))'],
        { encoding: 'utf8' }
      )
      assert.equal(paths.status, 0, paths.stderr)
      assert.ok(realpathSync(paths.stdout.trim()).startsWith(`${realpathSync(prefix)}/`))
      const preinstalled = join(paths.stdout.trim(), 'phi_test_dep-1.0.0.dist-info')
      mkdirSync(preinstalled, { recursive: true })
      writeFileSync(
        join(preinstalled, 'METADATA'),
        'Metadata-Version: 2.1\nName: phi-test-dep\nVersion: 1.0.0\n'
      )
      incompleteWheel = await createPythonWheelFixture(root, 'phi-test-dep @ $DEPENDENCY_URL')
      const incompleteLock = `phi-test-app @ ${incompleteWheel.url} --hash=sha256:${incompleteWheel.sha256}\n`
      writeFileSync(join(sourceDir, 'requirements.lock'), incompleteLock)
      input.installation = {
        backend: 'python-uv',
        requirements: './requirements.lock',
        requirementsSha256: digest(incompleteLock),
        executable: 'phi-test-app'
      }
      await assert.rejects(installPythonApplication(input), /require-hashes|hash|pinned/i)
    } finally {
      if (certificate === undefined) delete process.env.SSL_CERT_FILE
      else process.env.SSL_CERT_FILE = certificate
      if (!closed) await wheel.close()
      if (incompleteWheel) await incompleteWheel.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
)
