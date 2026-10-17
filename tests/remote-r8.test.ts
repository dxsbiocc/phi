import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  statSync,
  symlinkSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { main, type MainDependencies } from '../scripts/remote-r8'
import { parseR8Args, R8UsageError } from '../scripts/remote-r8/args'
import { executeParent } from '../scripts/remote-r8/parent'
import { cleanupScript, parsePreparation, prepareScript } from '../scripts/remote-r8/ssh-workspace'
import { assertTrackedTreeClean, currentCommit, gitRunner } from '../scripts/remote-r8/tree'
import type { R8Input } from '../scripts/remote-r8/types'
import type { R8RunResult } from '../scripts/remote-r8/runner'
import { resolveBunExecutable } from '../src/main/agent/engine/bun-executable'

const COMMIT = 'a'.repeat(40)
const BUNDLE = 'b'.repeat(64)

function fakeDeps(overrides: Partial<MainDependencies> & { status?: string } = {}): {
  deps: MainDependencies
  out: string[]
  calls: string[]
} {
  const out: string[] = []
  const calls: string[] = []
  const deps: MainDependencies = {
    repoRoot: tmpdir(),
    ompVersion: '18.10.3',
    git: (args) => {
      calls.push(`git ${args[0]}`)
      return args[0] === 'rev-parse' ? `${COMMIT}\n` : (overrides.status ?? '')
    },
    bundleHash: async () => {
      calls.push('bundle')
      return BUNDLE
    },
    resolveProfile: async () => {
      calls.push('resolveProfile')
      throw new Error('must not resolve a profile')
    },
    runChild: async () => {
      calls.push('runChild')
      throw new Error('must not start a child')
    },
    now: () => new Date('2026-01-01T00:00:00Z'),
    print: (text) => out.push(text),
    ...overrides
  }
  return { deps, out, calls }
}

test('plan mode prints host, root, commit, bundle and cases and starts nothing', async () => {
  const { deps, out, calls } = fakeDeps()
  const code = await main(['--host', 'yzhang-node3', '--runtime-root', '/tmp/phi-r8-example'], deps)
  assert.equal(code, 0)
  const text = out.join('\n')
  assert.match(text, /yzhang-node3/)
  assert.match(text, new RegExp(COMMIT))
  assert.match(text, new RegExp(BUNDLE))
  assert.match(text, /\/tmp\/phi-r8-example\/r8-acceptance\/<run-id>/)
  for (const name of [
    'native-search-read-edit-bash',
    'one-actual-blocking-child',
    'ssh-loss-reconnect-explicit-original-journal'
  ])
    assert.match(text, new RegExp(name))
  assert.match(text, /starts no SSH, SDK, provider or model process/)
  assert.ok(!calls.includes('runChild') && !calls.includes('resolveProfile'))
})

test('plan mode reports modified tracked files but does not refuse', async () => {
  const { deps, out } = fakeDeps({ status: ' M src/main/index.ts\n' })
  assert.equal(await main(['--host', 'GPU'], deps), 0)
  assert.match(out.join('\n'), /1 tracked file\(s\) modified: --execute would refuse/)
})

test('the CLI entry point prints a plan without connecting', () => {
  const run = spawnSync(
    'node',
    ['--import', './scripts/test-loader.mjs', 'scripts/remote-r8.ts', '--host', 'GPU'],
    { cwd: process.cwd(), encoding: 'utf8', timeout: 60_000 }
  )
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /Remote R8 acceptance plan for host "GPU" \(not executed\)/)
  assert.match(run.stdout, /Plan mode starts no SSH, SDK, provider or model process\./)
})

test('--execute refuses a dirty tracked tree before anything starts', async () => {
  const { deps, calls } = fakeDeps({ status: ' M src/main/index.ts\nM  docs/a.md\n' })
  const errors: string[] = []
  const original = console.error
  console.error = (message?: unknown) => void errors.push(String(message))
  try {
    assert.equal(await main(['--host', 'GPU', '--execute'], deps), 1)
  } finally {
    console.error = original
  }
  assert.match(errors.join('\n'), /Refusing --execute: 2 tracked file\(s\) are modified/)
  assert.ok(!calls.includes('runChild') && !calls.includes('resolveProfile'))
  assert.ok(!calls.includes('bundle'))
})

test('the clean-tree guard looks at tracked files only', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'phi-r8-git-')))
  try {
    const run = (...args: string[]): string =>
      execFileSync('git', args, { cwd: root, encoding: 'utf8' })
    run('init', '-q')
    run('config', 'user.email', 't@example.com')
    run('config', 'user.name', 't')
    writeFileSync(join(root, 'tracked.txt'), 'one\n')
    run('add', '.')
    run('commit', '-q', '-m', 'init')
    const git = gitRunner(root)
    assert.match(currentCommit(git), /^[a-f0-9]{40}$/)
    writeFileSync(join(root, 'untracked.txt'), 'x\n')
    assert.doesNotThrow(() => assertTrackedTreeClean(git))
    writeFileSync(join(root, 'tracked.txt'), 'two\n')
    assert.throws(() => assertTrackedTreeClean(git), /tracked\.txt/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('argument validation', () => {
  assert.deepEqual(parseR8Args(['--host', 'GPU']), {
    host: 'GPU',
    runtimeRoot: '~/.phi/runtime',
    runtimeRootExplicit: false,
    execute: false
  })
  assert.deepEqual(parseR8Args(['--execute', '--host', 'a.b-c', '--runtime-root', '/tmp/x/']), {
    host: 'a.b-c',
    runtimeRoot: '/tmp/x',
    runtimeRootExplicit: true,
    execute: true
  })
  for (const bad of [
    [],
    ['--host'],
    ['--host', '--execute'],
    ['--host', '-oProxyCommand=x'],
    ['--host', 'a b'],
    ['--host', 'GPU', '--host', 'xyx'],
    ['--host', 'GPU', '--runtime-root', 'relative/path'],
    ['--host', 'GPU', '--runtime-root', '/tmp/../etc'],
    ['--host', 'GPU', '--runtime-root', '/tmp/a\nb'],
    ['--host', 'GPU', '--runtime-root'],
    ['--host', 'GPU', '--execute', '--execute'],
    ['--host', 'GPU', '--expected-bundle-sha256', 'x'],
    ['--host=GPU']
  ])
    assert.throws(() => parseR8Args(bad), R8UsageError, JSON.stringify(bad))
})

test('the usage error exits with code 2 and starts nothing', async () => {
  const { deps, calls } = fakeDeps()
  const original = console.error
  console.error = () => undefined
  try {
    assert.equal(await main(['--host', 'bad host'], deps), 2)
  } finally {
    console.error = original
  }
  assert.deepEqual(calls, [])
})

test('the remote preparation and cleanup scripts are valid shell and keep their guards', () => {
  const input = (explicit: boolean, root: string): R8Input => ({
    runId: 'r8-12345678-1234-1234-1234-123456789abc',
    repoRoot: '/repo',
    localRoot: '/repo/.phi-acceptance/runs/r8-12345678-1234-1234-1234-123456789abc',
    host: 'GPU',
    profile: { hostAlias: 'GPU' },
    runtimeRoot: root,
    runtimeRootExplicit: explicit,
    bundleHash: BUNDLE,
    commit: COMMIT,
    realBun: '/bin/bun'
  })
  const scripts = [
    prepareScript(input(false, '~/.phi/runtime')),
    prepareScript(input(true, "/tmp/phi-r8-o'quote")),
    cleanupScript('/tmp/phi-root', input(false, '~/.phi/runtime').runId)
  ]
  for (const script of scripts) {
    const check = spawnSync('sh', ['-n'], { input: script, encoding: 'utf8' })
    assert.equal(check.status, 0, check.stderr)
  }
  const [defaultRoot, explicitRoot, cleanup] = scripts
  assert.match(defaultRoot, /mkdir -p -- "\$candidate"/)
  assert.match(explicitRoot, /\[ "\$\(stat -c %a -- "\$root"\)" = 700 \]/)
  assert.match(explicitRoot, /\[ "\$root" = "\$candidate" \]/)
  for (const script of scripts.slice(0, 2)) {
    assert.match(script, /\[ "\$\(stat -c %u -- "\$p"\)" = "\$\(id -u\)" \]/)
    assert.match(script, /\[ ! -e "\$work" \] && \[ ! -L "\$work" \]/)
  }
  assert.match(cleanup, /owner-token/)
  assert.match(cleanup, /rm -rf --one-file-system -- "\$work"/)
  assert.match(cleanup, /stat -c %h -- "\$marker"/)
})

function scriptInput(explicit: boolean, root: string): R8Input {
  const runId = 'r8-12345678-1234-1234-1234-123456789abc'
  return {
    runId,
    repoRoot: '/repo',
    localRoot: `/repo/.phi-acceptance/runs/${runId}`,
    host: 'GPU',
    profile: { hostAlias: 'GPU' },
    runtimeRoot: root,
    runtimeRootExplicit: explicit,
    bundleHash: BUNDLE,
    commit: COMMIT,
    realBun: '/bin/bun'
  }
}

/** The server scripts use GNU stat/rm; these shims map them onto the macOS tools for the test. */
function gnuShims(directory: string): string {
  const bin = join(directory, 'bin')
  mkdirSync(bin)
  writeFileSync(
    join(bin, 'stat'),
    `#!/bin/bash
if [ "$1" = -c ]; then
  case "$2" in %u) f=%u;; %a) f=%Lp;; %h) f=%l;; *) exit 9;; esac
  shift 3
  exec /usr/bin/stat -f "$f" "$@"
fi
exec /usr/bin/stat "$@"
`,
    { mode: 0o755 }
  )
  writeFileSync(
    join(bin, 'rm'),
    '#!/bin/bash\nargs=(); for a in "$@"; do [ "$a" = --one-file-system ] || args+=("$a"); done\nexec /bin/rm "${args[@]}"\n',
    { mode: 0o755 }
  )
  return bin
}

test('the server scripts create, verify and clean exactly the run tree', () => {
  if (process.platform === 'win32') return
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'phi-r8-script-')))
  try {
    const home = join(base, 'home')
    mkdirSync(home)
    const env = { PATH: `${gnuShims(base)}:${process.env.PATH}`, HOME: home }
    const sh = (script: string): ReturnType<typeof spawnSync> =>
      spawnSync('bash', ['-c', script], { env, encoding: 'utf8' })
    // Default root: created below HOME, listed as created, verified and reused on the next run.
    const first = sh(prepareScript(scriptInput(false, '~/.phi/runtime')))
    assert.equal(first.status, 0, String(first.stderr))
    const prepared = parsePreparation(String(first.stdout), scriptInput(false, '').runId)
    assert.equal(prepared.rootCreated, true)
    assert.equal(prepared.runtimeRoot, join(realpathSync(home), '.phi/runtime'))
    assert.equal(
      readFileSync(join(prepared.projectRoot, 'input.txt'), 'utf8'),
      `R8_SEED_${scriptInput(false, '').runId}\n`
    )
    const reused = sh(
      prepareScript({
        ...scriptInput(false, '~/.phi/runtime'),
        runId: 'r8-aaaaaaaa-1234-1234-1234-123456789abc'
      })
    )
    assert.equal(reused.status, 0, String(reused.stderr))
    assert.equal(
      parsePreparation(String(reused.stdout), 'r8-aaaaaaaa-1234-1234-1234-123456789abc')
        .rootCreated,
      false
    )
    // The same run id is never prepared twice.
    assert.notEqual(sh(prepareScript(scriptInput(false, '~/.phi/runtime'))).status, 0)
    // Cleanup refuses a wrong owner token, then removes the tree with the right one.
    const runId = scriptInput(false, '').runId
    const token = join(prepared.runtimeRoot, 'r8-acceptance', runId, 'owner-token')
    writeFileSync(token, 'someone-else\n', { mode: 0o600 })
    assert.notEqual(sh(cleanupScript(prepared.runtimeRoot, runId)).status, 0)
    writeFileSync(token, `${runId}\n`, { mode: 0o600 })
    const cleaned = sh(cleanupScript(prepared.runtimeRoot, runId))
    assert.equal(cleaned.status, 0, String(cleaned.stderr))
    assert.match(String(cleaned.stdout), /OWNED_TESTROOT_REMOVED/)
    assert.equal(readdirSync(join(prepared.runtimeRoot, 'r8-acceptance')).includes(runId), false)
    assert.ok(readdirSync(join(prepared.runtimeRoot, 'r8-acceptance')).length === 1)
    // A named root must already be exactly private, and a group-writable root is refused.
    const named = join(base, 'named-root')
    mkdirSync(named, { mode: 0o755 })
    chmodSync(named, 0o755)
    assert.notEqual(sh(prepareScript(scriptInput(true, named))).status, 0)
    chmodSync(named, 0o770)
    assert.notEqual(sh(prepareScript(scriptInput(true, named))).status, 0)
    chmodSync(named, 0o700)
    const ok = sh(prepareScript(scriptInput(true, named)))
    assert.equal(ok.status, 0, String(ok.stderr))
    assert.equal(parsePreparation(String(ok.stdout), runId).rootCreated, false)
    // A symlinked root is refused even when it points at a private directory.
    const link = join(base, 'link-root')
    symlinkSync(named, link)
    assert.notEqual(sh(prepareScript(scriptInput(true, link))).status, 0)
    // A named root that does not exist is created private.
    const fresh = join(base, 'fresh-root')
    const created = sh(prepareScript(scriptInput(true, fresh)))
    assert.equal(created.status, 0, String(created.stderr))
    assert.equal(parsePreparation(String(created.stdout), runId).rootCreated, true)
    assert.equal(statSync(fresh).mode & 0o777, 0o700)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('.phi-acceptance is ignored by git', () => {
  assert.match(readFileSync('.gitignore', 'utf8'), /^\.phi-acceptance\/$/m)
})

function okResult(runId: string): R8RunResult {
  return {
    runId,
    host: 'GPU',
    runtimeRootConfigured: '~/.phi/runtime',
    runtimeRoot: '/home/u/.phi/runtime',
    runtimeRootCreated: false,
    bundleHash: BUNDLE,
    ompVersion: '18.10.3',
    ok: true,
    cases: [{ case: 'native-search-read-edit-bash', elapsedMs: 12 }],
    providerRequests: 12,
    providerPurposes: { root: 10, child: 2, summary: 0 },
    startup: [
      { attempt: 1, kind: 'create', status: 'ready', totalMs: 5, remoteCommands: 3, steps: [] }
    ],
    tunnels: { opened: 2, closed: 2 },
    cleanup: {
      applicationClosed: true,
      rpcClosed: true,
      generationDirectoriesRemoved: true,
      tunnelsClosed: true,
      ownedTestRootRemoved: true,
      transportsClosed: true,
      failures: []
    },
    elapsedMs: 100
  }
}

async function runParent(options: { commits: string[]; childOk?: boolean }): Promise<{
  receipt: Awaited<ReturnType<typeof executeParent>>['receipt']
  receiptPath: string
  exitCode: number
  printed: string[]
  repoRoot: string
}> {
  const repoRoot = realpathSync(mkdtempSync(join(tmpdir(), 'phi-r8-parent-')))
  const printed: string[] = []
  const commits = [...options.commits]
  const outcome = await executeParent(
    { host: 'GPU', runtimeRoot: '~/.phi/runtime', runtimeRootExplicit: false, execute: true },
    {
      repoRoot,
      git: (args) => (args[0] === 'rev-parse' ? `${commits.shift() ?? COMMIT}\n` : ''),
      bundleHash: async () => BUNDLE,
      resolveProfile: async () => ({ hostAlias: 'GPU' }),
      runChild: async (inputPath, input) => {
        assert.equal(JSON.parse(readFileSync(inputPath, 'utf8')).commit, COMMIT)
        await mkdir(join(input.localRoot, 'agent/cache'), { recursive: true })
        if (options.childOk !== undefined) {
          const path = join(input.localRoot, 'result.json')
          await writeFile(path, JSON.stringify(okResult(input.runId)), { mode: 0o600 })
          chmodSync(path, 0o600)
        }
        return options.childOk === false ? 1 : 0
      },
      now: () => new Date('2026-01-01T00:00:00Z'),
      print: (text) => printed.push(text)
    }
  )
  return { ...outcome, printed, repoRoot }
}

test('a passing run writes one receipt with commit, bundle and cleanup, and removes the run directory', async () => {
  const run = await runParent({ commits: [COMMIT, COMMIT, COMMIT], childOk: true })
  try {
    assert.equal(run.exitCode, 0)
    assert.equal(run.receipt.ok, true)
    assert.equal(run.receipt.commit, COMMIT)
    assert.equal(run.receipt.commitStable, true)
    assert.equal(run.receipt.bundleHash, BUNDLE)
    assert.equal(run.receipt.ompVersion, '18.10.3')
    assert.equal(run.receipt.cleanup.localRunDirectoryRemoved, true)
    assert.deepEqual(readdirSync(join(run.repoRoot, '.phi-acceptance/runs')), [])
    const stored = JSON.parse(readFileSync(run.receiptPath, 'utf8'))
    assert.equal(stored.cases[0].name, 'native-search-read-edit-bash')
    assert.equal(stored.startup[0].remoteCommands, 3)
    assert.match(run.printed.join('\n'), /Remote R8 on GPU: PASS/)
  } finally {
    rmSync(run.repoRoot, { recursive: true, force: true })
  }
})

test('a HEAD that moves during the run fails the receipt and keeps the run directory', async () => {
  const run = await runParent({ commits: [COMMIT, 'c'.repeat(40)], childOk: true })
  try {
    assert.equal(run.exitCode, 1)
    assert.equal(run.receipt.commitStable, false)
    assert.match(run.receipt.failure?.reason ?? '', /HEAD changed/)
    assert.equal(readdirSync(join(run.repoRoot, '.phi-acceptance/runs')).length, 1)
  } finally {
    rmSync(run.repoRoot, { recursive: true, force: true })
  }
})

test('a child that leaves no result is a failed run with the reason recorded', async () => {
  const run = await runParent({ commits: [COMMIT, COMMIT, COMMIT] })
  try {
    assert.equal(run.exitCode, 1)
    assert.equal(run.receipt.ok, false)
    assert.equal(run.receipt.failure?.phase, 'child')
  } finally {
    rmSync(run.repoRoot, { recursive: true, force: true })
  }
})

test(
  'the three cases and cleanup run end to end against the local shell host',
  { timeout: 280_000 },
  async (t) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'phi-facade-regression-r8-')))
    for (const directory of ['home', 'agent', 'tmp'])
      await mkdir(join(root, directory), { mode: 0o700 })
    const child = spawn(
      'node',
      ['--import', './scripts/test-loader.mjs', './tests/helpers/remoteR8LocalOracle.ts'],
      {
        cwd: process.cwd(),
        env: {
          PATH: process.env.PATH,
          HOME: join(root, 'home'),
          PI_CODING_AGENT_DIR: join(root, 'agent'),
          TMPDIR: join(root, 'tmp'),
          XDG_DATA_HOME: join(root, 'home/.local/share'),
          XDG_CACHE_HOME: join(root, 'home/.cache'),
          PHI_PACKAGES_ROOT: process.env.PHI_PACKAGES_ROOT,
          PHI_TEST_REAL_BUN: resolveBunExecutable(),
          PHI_OMP_WORKER_PATH: join(process.cwd(), 'src/main/agent/engine/in-process/main.ts')
        },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => void (stdout += chunk.toString()))
    child.stderr.on('data', (chunk) => void (stderr += chunk.toString()))
    const abort = (): void => void child.kill()
    t.signal.addEventListener('abort', abort, { once: true })
    try {
      const exit = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject)
        child.once('exit', resolve)
      })
      assert.equal(exit, 0, stdout + stderr)
      const line = stdout.split('\n').find((candidate) => candidate.startsWith('R8_LOCAL_RESULT '))
      assert.ok(line, stdout + stderr)
      const result = JSON.parse(line.slice('R8_LOCAL_RESULT '.length)) as R8RunResult
      assert.equal(result.ok, true, JSON.stringify([result.failureReason, result.cleanup.failures]))
      assert.deepEqual(
        result.cases.map((entry) => entry.case),
        [
          'native-search-read-edit-bash',
          'one-actual-blocking-child',
          'ssh-loss-reconnect-explicit-original-journal'
        ]
      )
      assert.equal(result.providerRequests, 12)
      assert.deepEqual(result.providerPurposes, { root: 10, child: 2, summary: 0 })
      assert.equal(result.rpcGenerations, 2)
      assert.deepEqual(result.cleanup, {
        applicationClosed: true,
        rpcClosed: true,
        generationDirectoriesRemoved: true,
        tunnelsClosed: true,
        ownedTestRootRemoved: true,
        transportsClosed: true,
        failures: []
      })
      assert.equal(result.startup.length, 2)
      for (const report of result.startup) assert.equal(report.status, 'ready')
      assert.ok((result.startup[0].remoteCommands as number) > 0)
    } finally {
      t.signal.removeEventListener('abort', abort)
      child.kill()
      rmSync(root, { recursive: true, force: true })
    }
  }
)
