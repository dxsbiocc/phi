import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  OFFICECLI_PLATFORM_IDS,
  lookupOfficeCliPlatform,
  officePlatformId
} from '../scripts/office/fetch-officecli.mjs'
import { officeCliEnv, runOfficeCli } from '../src/main/agent/office/office-driver'
import {
  OFFICECLI_PLATFORM_IDS as RUNTIME_PLATFORM_IDS,
  REQUIRED_OFFICECLI_COMMANDS,
  detectOfficeRuntime,
  officeBinaryCandidates,
  type OfficeManifest
} from '../src/main/agent/office/office-runtime'

const repoRoot = process.cwd()
const VERSION = '1.0.153'

const FULL_HELP = [
  'Description:',
  '  officecli: AI-friendly CLI for Office documents',
  '',
  'Commands:',
  ...REQUIRED_OFFICECLI_COMMANDS.map((name) => `  ${name} <file>    does ${name}`),
  '  help <format>    reference',
  ''
].join('\n')
const BATCH_HELP = 'Options:\n  --input <input>\n  --commands <commands>\n  --best-effort  x\n'

interface FakeOptions {
  version?: string
  help?: string
  batchHelp?: string
  exitCode?: number
  sleepSeconds?: number
}

interface Fixture {
  root: string
  binaryPath: string
  logPath: string
  workDir: string
  manifest: OfficeManifest
}

function sha256Of(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** A shell script that stands in for officecli; every invocation is logged. */
function makeFixture(options: FakeOptions = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'office runtime '))
  const dir = join(root, 'bin dir')
  const workDir = join(root, 'cwd')
  mkdirSync(dir, { recursive: true })
  mkdirSync(workDir, { recursive: true })
  const logPath = join(root, 'calls.log')
  const binaryPath = join(dir, 'officecli')
  const version = options.version ?? VERSION
  const script = [
    '#!/bin/sh',
    `echo "ARGS=$* SKIP=$OFFICECLI_SKIP_UPDATE KEY=\${ANTHROPIC_API_KEY-unset} AGENT=\${PI_CODING_AGENT_DIR-unset} PWD=$(pwd)" >> '${logPath}'`,
    options.sleepSeconds ? `sleep ${options.sleepSeconds}` : ':',
    options.exitCode ? `exit ${options.exitCode}` : ':',
    'case "$1" in',
    `  --version) echo '${version}' ;;`,
    `  --help) cat <<'EOF_HELP'`,
    options.help ?? FULL_HELP,
    'EOF_HELP',
    '  ;;',
    `  batch) cat <<'EOF_BATCH'`,
    options.batchHelp ?? BATCH_HELP,
    'EOF_BATCH',
    '  ;;',
    'esac'
  ].join('\n')
  writeFileSync(binaryPath, script)
  chmodSync(binaryPath, 0o755)
  const manifest: OfficeManifest = {
    version: VERSION,
    platforms: {
      'darwin-arm64': { url: 'https://example.test/officecli', sha256: sha256Of(binaryPath) }
    }
  }
  return { root, binaryPath, logPath, workDir, manifest }
}

function detect(
  fixture: Fixture,
  overrides: Partial<Parameters<typeof detectOfficeRuntime>[0]> = {}
): ReturnType<typeof detectOfficeRuntime> {
  return detectOfficeRuntime({
    manifest: fixture.manifest,
    platform: 'darwin',
    arch: 'arm64',
    candidates: [fixture.binaryPath],
    cwd: fixture.workDir,
    timeoutMs: 30_000,
    ...overrides
  })
}

function calls(fixture: Fixture): string[] {
  return existsSync(fixture.logPath)
    ? readFileSync(fixture.logPath, 'utf8').split('\n').filter(Boolean)
    : []
}

test('office manifest pins the release and lists only the supported macOS platforms', () => {
  const manifest = JSON.parse(
    readFileSync(join(repoRoot, 'resources', 'office', 'manifest.json'), 'utf8')
  ) as { officecli: OfficeManifest }
  const { version, platforms } = manifest.officecli

  assert.match(version, /^\d+\.\d+\.\d+$/)
  assert.deepEqual(Object.keys(platforms).sort(), [...OFFICECLI_PLATFORM_IDS].sort())
  for (const platformId of OFFICECLI_PLATFORM_IDS) {
    const release = lookupOfficeCliPlatform(manifest, platformId)
    assert.ok(release)
    assert.match(release.sha256, /^[0-9a-f]{64}$/)
    assert.ok(
      release.url.startsWith(
        `https://github.com/iOfficeAI/OfficeCLI/releases/download/v${version}/officecli-mac-`
      )
    )
  }
  assert.equal(lookupOfficeCliPlatform(manifest, 'win32-x64'), undefined)
})

test('runtime and fetch script agree on the supported platforms', () => {
  assert.deepEqual([...RUNTIME_PLATFORM_IDS], [...OFFICECLI_PLATFORM_IDS])
})

test('office platform ids cover macOS only', () => {
  assert.equal(officePlatformId('darwin', 'arm64'), 'darwin-arm64')
  assert.equal(officePlatformId('darwin', 'x64'), 'darwin-x64')
  assert.equal(officePlatformId('linux', 'x64'), undefined)
  assert.equal(officePlatformId('win32', 'x64'), undefined)
})

test('binary candidates recognize the user-writable Phi install location after bundled paths', () => {
  assert.deepEqual(
    officeBinaryCandidates('darwin-arm64', {
      resourcesPath: '/App/Contents/Resources',
      bundledOfficeDir: '/repo/resources/office',
      agentDir: '/Users/example/.phi'
    }),
    [
      '/App/Contents/Resources/office/officecli/darwin-arm64/officecli',
      '/repo/resources/office/officecli/darwin-arm64/officecli',
      '/Users/example/.phi/office/officecli/darwin-arm64/officecli'
    ]
  )
  assert.deepEqual(
    officeBinaryCandidates('darwin-arm64', {
      bundledOfficeDir: '/repo/resources/office',
      agentDir: '/Users/example/.phi'
    }),
    [
      '/repo/resources/office/officecli/darwin-arm64/officecli',
      '/Users/example/.phi/office/officecli/darwin-arm64/officecli'
    ]
  )
})

test('an unsupported platform is reported without running anything', async () => {
  const fixture = makeFixture()
  try {
    const status = await detect(fixture, { platform: 'linux', arch: 'x64' })
    assert.deepEqual(status, { state: 'unsupported-platform', platform: 'linux-x64' })
    assert.deepEqual(calls(fixture), [])
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('a missing binary reports the user installation target without offering an in-app download', async () => {
  const fixture = makeFixture()
  try {
    const missing = join(fixture.root, 'nowhere', 'officecli')
    const status = await detect(fixture, { candidates: [join(fixture.root, 'a'), missing] })
    assert.equal(status.state, 'missing')
    assert.equal(status.state === 'missing' && status.expectedPath, missing)
    assert.equal(
      status.state === 'missing' ? status.hint : '',
      `请将已校验的 OfficeCLI 安装到 ${missing} 后重试。`
    )
    assert.doesNotMatch(status.state === 'missing' ? status.hint : '', /下载|office:fetch/u)
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('a matching binary is available and runs from a path containing spaces', async () => {
  const fixture = makeFixture()
  try {
    assert.ok(fixture.binaryPath.includes(' '))
    const status = await detect(fixture)
    assert.deepEqual(status, {
      state: 'available',
      binaryPath: fixture.binaryPath,
      version: VERSION,
      platform: 'darwin-arm64'
    })
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('a different version is rejected even when the checksum matches the manifest', async () => {
  const fixture = makeFixture({ version: '1.0.200' })
  try {
    const status = await detect(fixture)
    assert.deepEqual(status, {
      state: 'version-mismatch',
      binaryPath: fixture.binaryPath,
      expected: VERSION,
      found: '1.0.200'
    })
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('a checksum mismatch is reported and the binary is never executed', async () => {
  const fixture = makeFixture()
  try {
    const tampered: OfficeManifest = {
      version: VERSION,
      platforms: { 'darwin-arm64': { url: 'https://example.test/x', sha256: '0'.repeat(64) } }
    }
    const status = await detect(fixture, { manifest: tampered })
    assert.deepEqual(status, { state: 'checksum-mismatch', binaryPath: fixture.binaryPath })
    assert.deepEqual(calls(fixture), [])
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('a binary missing required commands or batch flags is incompatible', async () => {
  const noBatch = makeFixture({ help: FULL_HELP.replace('  batch <file>    does batch\n', '') })
  const noFlags = makeFixture({ batchHelp: 'Options:\n  --input <input>\n' })
  try {
    const missingCommand = await detect(noBatch)
    assert.equal(missingCommand.state, 'incompatible')
    assert.deepEqual(missingCommand.state === 'incompatible' && missingCommand.missing, ['batch'])

    const missingFlags = await detect(noFlags)
    assert.equal(missingFlags.state, 'incompatible')
    assert.deepEqual(missingFlags.state === 'incompatible' && missingFlags.missing, [
      'batch --commands',
      'batch --best-effort'
    ])
  } finally {
    rmSync(noBatch.root, { recursive: true, force: true })
    rmSync(noFlags.root, { recursive: true, force: true })
  }
})

test('a binary that fails or hangs is unusable with a reason', async () => {
  const failing = makeFixture({ exitCode: 3 })
  const hanging = makeFixture({ sleepSeconds: 5 })
  try {
    const failed = await detect(failing)
    assert.equal(failed.state, 'unusable')
    assert.match(failed.state === 'unusable' ? failed.reason : '', /exit/i)

    const timedOut = await detect(hanging, { timeoutMs: 300 })
    assert.equal(timedOut.state, 'unusable')
    assert.match(timedOut.state === 'unusable' ? timedOut.reason : '', /timed out/i)
  } finally {
    rmSync(failing.root, { recursive: true, force: true })
    rmSync(hanging.root, { recursive: true, force: true })
  }
})

test('probing only reads help and version, disables updates, and creates nothing', async () => {
  const fixture = makeFixture()
  const previousKey = process.env.ANTHROPIC_API_KEY
  const previousAgent = process.env.PI_CODING_AGENT_DIR
  process.env.ANTHROPIC_API_KEY = 'secret-for-test'
  process.env.PI_CODING_AGENT_DIR = '/tmp/agent-dir'
  try {
    const before = readdirSync(fixture.workDir)
    await detect(fixture)
    assert.deepEqual(readdirSync(fixture.workDir), before)

    const logged = calls(fixture)
    assert.equal(logged.length, 3)
    assert.match(logged[0], /^ARGS=--version /)
    assert.match(logged[1], /^ARGS=--help /)
    assert.match(logged[2], /^ARGS=batch --help /)
    for (const line of logged) {
      assert.match(line, /SKIP=1 /)
      assert.match(line, /KEY=unset /)
      assert.match(line, /AGENT=unset /)
      assert.doesNotMatch(line, /ARGS=install|ARGS= /)
    }
  } finally {
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = previousKey
    if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgent
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('officeCliEnv keeps an allowlist and always disables auto-update', () => {
  const env = officeCliEnv({
    HOME: '/home/u',
    LANG: 'en_US.UTF-8',
    PATH: '/usr/bin',
    OPENAI_API_KEY: 'k',
    OFFICECLI_SKIP_UPDATE: '0'
  })
  assert.equal(env.HOME, '/home/u')
  assert.equal(env.LANG, 'en_US.UTF-8')
  assert.equal(env.OFFICECLI_SKIP_UPDATE, '1')
  assert.equal(env.OPENAI_API_KEY, undefined)
  assert.equal(env.PATH, undefined)
})

test('runOfficeCli passes arguments as an array without shell interpretation', async () => {
  const fixture = makeFixture()
  try {
    const result = await runOfficeCli(fixture.binaryPath, ['--version', '$(touch pwned); `id`'], {
      cwd: fixture.workDir,
      timeoutMs: 30_000
    })
    assert.equal(result.exitCode, 0)
    assert.equal(existsSync(join(fixture.workDir, 'pwned')), false)
    assert.match(calls(fixture)[0], /\$\(touch pwned\); `id`/)
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('runOfficeCli reports the spawned pid so a long-running watch can be owned', async () => {
  const fixture = makeFixture({ sleepSeconds: 5 })
  let pid: number | undefined
  try {
    const result = await runOfficeCli(
      fixture.binaryPath,
      ['watch', 'draft.xlsx', '--port', '31001'],
      {
        cwd: fixture.workDir,
        timeoutMs: 200,
        onSpawn: (spawnedPid) => {
          pid = spawnedPid
        }
      }
    )
    assert.equal(result.timedOut, true)
    assert.ok(pid && pid > 0)
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('runOfficeCli allows an owned watch to run until it is aborted', async () => {
  const fixture = makeFixture({ sleepSeconds: 5 })
  const controller = new AbortController()
  try {
    const result = await runOfficeCli(
      fixture.binaryPath,
      ['watch', 'draft.xlsx', '--port', '31001'],
      {
        cwd: fixture.workDir,
        timeoutMs: 0,
        signal: controller.signal,
        onSpawn: () => setTimeout(() => controller.abort(), 50)
      }
    )
    assert.equal(result.timedOut, false)
    assert.match(result.spawnError ?? '', /abort/i)
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})
