import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { after, before, describe, test } from 'node:test'

import {
  currentPlatform,
  ensureEnvironment,
  parseEnvironmentSpec,
  removeTree,
  runInEnvironment,
  type EnsureEnvironmentResult,
  type RunResult
} from '../../src/main/agent/envs'
import { getMicromambaPath } from '../../src/main/agent/envs/paths'

const SYSTEM_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'] as const
const FORBIDDEN_PATH_TOKENS = ['homebrew', 'miniconda', 'conda', 'pyenv', '.local/bin'] as const
const DROPPED_NAMES = [
  'CONDA_PREFIX',
  'VIRTUAL_ENV',
  'R_HOME',
  'JAVA_HOME',
  'DYLD_LIBRARY_PATH',
  'FOO_BAR'
] as const
const HOST_SENTINELS: Record<(typeof DROPPED_NAMES)[number], string> = {
  CONDA_PREFIX: '/phi-host-sentinel/conda-prefix',
  VIRTUAL_ENV: '/phi-host-sentinel/virtual-env',
  R_HOME: '/phi-host-sentinel/r-home',
  JAVA_HOME: '/phi-host-sentinel/java-home',
  DYLD_LIBRARY_PATH: '/phi-host-sentinel/dyld',
  FOO_BAR: 'phi-host-sentinel-foo-bar'
}
const COMMAND_TIMEOUT_MS = 120_000
const BUILD_TIMEOUT_MS = 3_600_000

const offlineSkip =
  process.env.PHI_OFFLINE === '1' ? 'PHI_OFFLINE=1; runtime isolation tests skipped' : false

interface TreeEntry {
  path: string
  size: number
  mtimeMs: number
}

interface DirectResult {
  status: number | null
  stdout: string
  stderr: string
  error?: string
}

let root = ''
let ownsRoot = false
let scratch = ''
let pythonEnv: EnsureEnvironmentResult | undefined
let rEnv: EnsureEnvironmentResult | undefined
let pythonTree: TreeEntry[] = []
let rTree: TreeEntry[] = []

function evidence(message: string): void {
  console.log(`[isolation] ${message}`)
}

function clip(text: string, limit = 600): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= limit) return flat
  return `${flat.slice(0, limit)}...`
}

function canonical(path: string): string {
  const absolute = resolve(path)
  try {
    return realpathSync(absolute)
  } catch {
    try {
      return join(realpathSync(dirname(absolute)), basename(absolute))
    } catch {
      return absolute
    }
  }
}

function samePath(left: string, right: string): boolean {
  return canonical(left) === canonical(right)
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(canonical(parent), canonical(child))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function scratchDir(): string {
  if (!scratch) throw new Error('scratch directory was not created')
  return scratch
}

function requirePython(): EnsureEnvironmentResult {
  if (!pythonEnv) throw new Error('python environment was not built')
  return pythonEnv
}

function requireR(): EnsureEnvironmentResult {
  if (!rEnv) throw new Error('R environment was not built')
  return rEnv
}

function directEnv(overrides: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {
    PATH: SYSTEM_PATH.join(':'),
    HOME: process.env.HOME ?? '/',
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    TMPDIR: process.env.TMPDIR ?? '/tmp'
  }
  if (process.env.USER) env.USER = process.env.USER
  if (process.env.LOGNAME) env.LOGNAME = process.env.LOGNAME
  if (process.env.TERM) env.TERM = process.env.TERM
  for (const [key, value] of Object.entries(overrides)) env[key] = value
  return env
}

function runDirect(
  command: string,
  args: readonly string[],
  env: Record<string, string>
): DirectResult {
  const result = spawnSync(command, args, {
    cwd: scratchDir(),
    encoding: 'utf8',
    env,
    shell: false,
    timeout: COMMAND_TIMEOUT_MS
  })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ...(result.error ? { error: result.error.message } : {})
  }
}

async function runIsolated(
  env: EnsureEnvironmentResult,
  argv: string[],
  baseEnv: NodeJS.ProcessEnv
): Promise<RunResult> {
  return runInEnvironment(env, argv, {
    cwd: scratchDir(),
    baseEnv,
    timeoutMs: COMMAND_TIMEOUT_MS
  })
}

function loadFixture(name: string): { specText: string; lockText: string } {
  const dir = join(process.cwd(), 'tests/fixtures/envs', name)
  return {
    specText: readFileSync(join(dir, 'environment.yml'), 'utf8'),
    lockText: readFileSync(join(dir, 'locks', `${currentPlatform()}.txt`), 'utf8')
  }
}

async function buildFixture(name: string): Promise<EnsureEnvironmentResult> {
  const fixture = loadFixture(name)
  const parsed = parseEnvironmentSpec(fixture.specText)
  if (!parsed.ok) throw new Error(parsed.errors.join('; '))
  evidence(`building ${name}`)
  const result = await ensureEnvironment({
    root,
    scope: 'phi',
    kind: 'base',
    spec: parsed.spec,
    lockText: fixture.lockText,
    onProgress: (event) => evidence(`ensure ${name}: ${event.phase} ${event.message}`)
  })
  evidence(`${name} envId=${result.envId} created=${result.created} prefix=${result.prefix}`)
  return result
}

function listTree(directory: string): TreeEntry[] {
  const found: TreeEntry[] = []
  const walk = (current: string, rel: string): void => {
    const entries = readdirSync(current, { withFileTypes: true })
    for (const entry of entries) {
      const name = rel.length === 0 ? entry.name : `${rel}/${entry.name}`
      const full = join(current, entry.name)
      if (entry.isSymbolicLink()) {
        const stat = lstatSync(full)
        found.push({ path: name, size: stat.size, mtimeMs: stat.mtimeMs })
        continue
      }
      if (entry.isDirectory()) {
        found.push({ path: `${name}/`, size: 0, mtimeMs: 0 })
        walk(full, name)
        continue
      }
      const stat = lstatSync(full)
      found.push({ path: name, size: stat.size, mtimeMs: stat.mtimeMs })
    }
  }
  walk(directory, '')
  found.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  return found
}

function assertSameTree(
  label: string,
  beforeTree: readonly TreeEntry[],
  afterTree: readonly TreeEntry[]
): void {
  const beforeMap = new Map(beforeTree.map((entry) => [entry.path, entry]))
  const afterMap = new Map(afterTree.map((entry) => [entry.path, entry]))
  const added = afterTree.filter((entry) => !beforeMap.has(entry.path)).map((entry) => entry.path)
  const removed = beforeTree.filter((entry) => !afterMap.has(entry.path)).map((entry) => entry.path)
  const changed: string[] = []
  for (const entry of afterTree) {
    const previous = beforeMap.get(entry.path)
    if (!previous || previous.path.endsWith('/')) continue
    if (previous.size !== entry.size || previous.mtimeMs !== entry.mtimeMs) changed.push(entry.path)
  }
  assert.deepEqual(
    { added, removed, changed },
    { added: [], removed: [], changed: [] },
    `CONTRACT VIOLATION: ${label} changed added=${added.slice(0, 20).join(',')} removed=${removed
      .slice(0, 20)
      .join(',')} changed=${changed.slice(0, 20).join(',')}`
  )
}

/** Same rule as doctor.ts: symlinks are not followed; a regular file with any write bit is writable. */
function writableRegularFiles(directory: string): string[] {
  const found: string[] = []
  const walk = (current: string): void => {
    const entries = readdirSync(current, { withFileTypes: true }).sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0
    )
    const children: string[] = []
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const full = join(current, entry.name)
      if (entry.isFile()) {
        let mode: number
        try {
          mode = lstatSync(full).mode
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          if (code === 'ENOENT') continue
          throw error
        }
        if ((mode & 0o222) !== 0) found.push(full)
        continue
      }
      if (entry.isDirectory()) children.push(full)
    }
    for (const child of children) walk(child)
  }
  walk(directory)
  return found
}

function parseJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout) as unknown
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`expected JSON stdout (${message}): ${clip(stdout)}`)
  }
}

function parseEnvOutput(stdout: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const line of stdout.split('\n')) {
    if (line.length === 0) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    map.set(line.slice(0, eq), line.slice(eq + 1))
  }
  return map
}

function rString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function linesWithPrefix(stdout: string, prefix: string): string[] {
  return stdout
    .split('\n')
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length))
}

function assertControl(label: string, ok: boolean, detail: string): void {
  evidence(`${label} control: ${ok ? 'succeeded' : 'FAILED'} ${detail}`)
  assert.equal(ok, true, `${label} control failed (case invalid): ${detail}`)
}

function cacheDir(env: EnsureEnvironmentResult): string {
  return join(dirname(dirname(env.prefix)), 'cache', env.envId)
}

function allowedPathEntries(env: EnsureEnvironmentResult): Set<string> {
  const allowed = new Set<string>()
  const allow = (entry: string): void => {
    if (entry.length === 0) return
    allowed.add(entry)
    allowed.add(canonical(entry))
  }
  allow(join(env.prefix, 'bin'))
  // Activation entries count only when they are inside the prefix (execution contract § PATH).
  for (const entry of env.metadata.activation.pathPrepend) {
    if (isInside(entry, env.prefix)) allow(entry)
  }
  for (const executable of Object.values(env.metadata.host)) allow(dirname(executable))
  for (const entry of SYSTEM_PATH) allow(entry)
  return allowed
}

function forbiddenToken(entry: string): string | undefined {
  const lower = entry.toLowerCase()
  return FORBIDDEN_PATH_TOKENS.find((token) => lower.includes(token))
}

describe(
  'runtime isolation conformance',
  {
    ...(offlineSkip ? { skip: offlineSkip } : {}),
    concurrency: 1,
    timeout: COMMAND_TIMEOUT_MS
  },
  () => {
    before(
      async () => {
        const micromamba = getMicromambaPath()
        evidence(`micromamba=${micromamba}`)
        const persistent = process.env.PHI_TEST_RUNTIME_ROOT
        if (persistent) {
          root = persistent
          ownsRoot = false
          mkdirSync(root, { recursive: true })
        } else {
          root = mkdtempSync(join(tmpdir(), 'phi-runtime-isolation-'))
          ownsRoot = true
        }
        scratch = mkdtempSync(join(tmpdir(), 'phi-runtime-isolation-scratch-'))
        evidence(`runtime root=${root} ownsRoot=${ownsRoot}`)
        pythonEnv = await buildFixture('minimal')
        rEnv = await buildFixture('r-source')
        pythonTree = listTree(pythonEnv.prefix)
        rTree = listTree(rEnv.prefix)
      },
      { timeout: BUILD_TIMEOUT_MS }
    )

    after(() => {
      if (scratch) removeTree(scratch)
      if (ownsRoot && root) removeTree(root)
    })

    test('1. interpreter location is inside the prefix', async () => {
      const env = requirePython()
      const result = await runIsolated(
        env,
        ['python', '-c', 'import sys, json; print(json.dumps([sys.executable, sys.prefix]))'],
        { ...process.env }
      )
      assert.equal(result.exitCode, 0, clip(result.stderr))
      const parsed = parseJson(result.stdout)
      assert.ok(Array.isArray(parsed) && parsed.length === 2, clip(result.stdout))
      const executable = parsed[0]
      const sysPrefix = parsed[1]
      assert.equal(typeof executable, 'string')
      assert.equal(typeof sysPrefix, 'string')
      if (typeof executable !== 'string' || typeof sysPrefix !== 'string') return
      assert.ok(isInside(executable, env.prefix), `sys.executable outside prefix: ${executable}`)
      assert.ok(isInside(sysPrefix, env.prefix), `sys.prefix outside prefix: ${sysPrefix}`)
      assert.ok(
        isInside(result.resolvedCommand, env.prefix),
        `resolvedCommand outside prefix: ${result.resolvedCommand}`
      )
      evidence(
        `case 1 control: not applicable; sys.executable=${executable} sys.prefix=${sysPrefix} resolvedCommand=${result.resolvedCommand}`
      )
    })

    test('2. PYTHONPATH host module is not importable', async () => {
      const env = requirePython()
      const hostDir = mkdtempSync(join(scratchDir(), 'pythonpath-'))
      writeFileSync(join(hostDir, 'phi_host_only.py'), 'VALUE = "host-pythonpath"\n')
      const code = 'import phi_host_only; print(phi_host_only.VALUE)'
      const pythonBin = join(env.prefix, 'bin', 'python')
      const controlEnvironment = directEnv({ PYTHONPATH: hostDir })
      const control = runDirect(pythonBin, ['-c', code], controlEnvironment)
      const controlOk = control.status === 0 && control.stdout.includes('host-pythonpath')
      assertControl(
        'case 2 PYTHONPATH',
        controlOk,
        `exit=${control.status} error=${control.error ?? ''} stdout=${clip(control.stdout)} stderr=${clip(control.stderr)}`
      )

      const isolated = await runIsolated(env, ['python', '-c', code], {
        ...process.env,
        PYTHONPATH: hostDir
      })
      const output = `${isolated.stderr}\n${isolated.stdout}`
      evidence(
        `case 2 PYTHONPATH isolated: exit=${isolated.exitCode} stdout=${clip(isolated.stdout)} stderr=${clip(isolated.stderr)}`
      )
      assert.notEqual(
        isolated.exitCode,
        0,
        `CONTRACT VIOLATION: phi_host_only imported via PYTHONPATH\n${clip(output, 1200)}`
      )
      assert.match(output, /ModuleNotFoundError: No module named 'phi_host_only'/)
    })

    test('3. user site host module is not importable', async () => {
      const env = requirePython()
      const userHome = mkdtempSync(join(scratchDir(), 'user-home-'))
      const pythonBin = join(env.prefix, 'bin', 'python')
      const probeEnv = directEnv({ HOME: userHome })
      assert.equal(probeEnv.PYTHONNOUSERSITE, undefined)
      const probe = runDirect(pythonBin, ['-m', 'site', '--user-site'], probeEnv)
      assert.equal(
        probe.status,
        0,
        `user site probe failed (case invalid): exit=${probe.status} stdout=${clip(probe.stdout)} stderr=${clip(probe.stderr)}`
      )
      const userSite = probe.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('/'))
        .at(-1)
      assert.ok(userSite, `python -m site --user-site did not print a path: ${clip(probe.stdout)}`)
      mkdirSync(userSite, { recursive: true })
      writeFileSync(join(userSite, 'phi_user_only.py'), 'VALUE = "host-user-site"\n')
      evidence(`case 3 user site directory=${userSite}`)

      const code = 'import phi_user_only; print(phi_user_only.VALUE)'
      const control = runDirect(pythonBin, ['-c', code], probeEnv)
      const controlOk = control.status === 0 && control.stdout.includes('host-user-site')
      assertControl(
        'case 3 user site',
        controlOk,
        `exit=${control.status} error=${control.error ?? ''} stdout=${clip(control.stdout)} stderr=${clip(control.stderr)}`
      )

      const isolated = await runIsolated(env, ['python', '-c', code], {
        ...process.env,
        HOME: userHome,
        PYTHONNOUSERSITE: '0'
      })
      const output = `${isolated.stderr}\n${isolated.stdout}`
      evidence(
        `case 3 user site isolated: exit=${isolated.exitCode} stdout=${clip(isolated.stdout)} stderr=${clip(isolated.stderr)}`
      )
      assert.notEqual(
        isolated.exitCode,
        0,
        `CONTRACT VIOLATION: phi_user_only imported from the user site\n${clip(output, 1200)}`
      )
      assert.match(output, /ModuleNotFoundError: No module named 'phi_user_only'/)
    })

    test('4. PATH contains only the environment, host dependencies, and system directories', async () => {
      const env = requirePython()
      const poison = [
        '/opt/homebrew/bin',
        '/usr/local/Caskroom/miniconda/bin',
        join(scratchDir(), 'pyenv', 'shims'),
        join(scratchDir(), '.local', 'bin')
      ]
      const hostPath = [process.env.PATH ?? '', ...poison].join(':')
      const control = runDirect('/usr/bin/env', [], directEnv({ PATH: hostPath }))
      const controlPath = parseEnvOutput(control.stdout).get('PATH') ?? ''
      const controlEntries = controlPath.split(':').filter((entry) => entry.length > 0)
      const controlOk =
        control.status === 0 && poison.every((entry) => controlEntries.includes(entry))
      assertControl(
        'case 4 PATH',
        controlOk,
        `exit=${control.status} error=${control.error ?? ''} PATH=${clip(controlPath)} stderr=${clip(control.stderr)}`
      )

      const isolated = await runIsolated(env, ['/usr/bin/env'], {
        ...process.env,
        PATH: hostPath
      })
      assert.equal(isolated.exitCode, 0, clip(isolated.stderr))
      const childPath = parseEnvOutput(isolated.stdout).get('PATH')
      assert.ok(childPath, 'child has no PATH')
      const entries = childPath.split(':')
      assert.deepEqual(
        entries.filter((entry) => entry.length === 0),
        [],
        `PATH has an empty entry: ${childPath}`
      )
      const present = entries.filter((entry) => entry.length > 0)
      assert.ok(present.length > 0, 'PATH is empty')
      const first = present[0] ?? ''
      assert.ok(isInside(first, env.prefix), `PATH does not start inside the prefix: ${first}`)

      const allowed = allowedPathEntries(env)
      const rejected = present.filter(
        (entry) => !allowed.has(entry) && !allowed.has(canonical(entry))
      )
      const hostEntries = hostPath.split(':').filter((entry) => entry.length > 0)
      const hostLeaked = present.filter((entry) => {
        const canon = canonical(entry)
        const fromHost = hostEntries.some((host) => host === entry || canonical(host) === canon)
        return fromHost && !allowed.has(entry) && !allowed.has(canon)
      })
      const forbidden = present.filter(
        (entry) => !isInside(entry, env.prefix) && forbiddenToken(entry)
      )
      evidence(
        `case 4 PATH isolated: ${present.join(':')} pathPrepend=${env.metadata.activation.pathPrepend.join(':')} hostKeys=${Object.keys(env.metadata.host).join(',')}`
      )
      assert.deepEqual(
        rejected,
        [],
        `CONTRACT VIOLATION: PATH entries outside the environment, host dependencies, and system directories: ${rejected.join(', ')}`
      )
      assert.deepEqual(
        hostLeaked,
        [],
        `CONTRACT VIOLATION: host PATH entries leaked: ${hostLeaked.join(', ')}`
      )
      assert.deepEqual(
        forbidden,
        [],
        `CONTRACT VIOLATION: PATH entries contain a host toolchain token: ${forbidden
          .map((entry) => `${entry} (${forbiddenToken(entry) ?? ''})`)
          .join(', ')}`
      )
    })

    test('5. host toolchain variables are dropped', async () => {
      const env = requirePython()
      const pythonBin = join(env.prefix, 'bin', 'python')
      const code =
        'import json, os\n' +
        `keys = ${JSON.stringify([...DROPPED_NAMES])}\n` +
        'print(json.dumps({key: os.environ[key] for key in keys if key in os.environ}))\n'
      const controlEnvironment = directEnv({ ...HOST_SENTINELS })
      const control = runDirect(pythonBin, ['-c', code], controlEnvironment)
      const controlDump =
        control.status === 0 ? (parseJson(control.stdout) as Record<string, unknown>) : {}
      const controlOk =
        control.status === 0 &&
        DROPPED_NAMES.every((name) => controlDump[name] === HOST_SENTINELS[name])
      assertControl(
        'case 5 dropped variables',
        controlOk,
        `exit=${control.status} error=${control.error ?? ''} stdout=${clip(control.stdout)} stderr=${clip(control.stderr)}`
      )

      const isolated = await runIsolated(env, ['python', '-c', code], {
        ...process.env,
        ...HOST_SENTINELS
      })
      assert.equal(isolated.exitCode, 0, clip(isolated.stderr))
      const dumped = parseJson(isolated.stdout)
      assert.equal(typeof dumped, 'object')
      assert.ok(dumped !== null && !Array.isArray(dumped))
      const present = dumped as Record<string, unknown>
      for (const name of DROPPED_NAMES) {
        const actual = present[name]
        assert.notEqual(
          actual,
          HOST_SENTINELS[name],
          `CONTRACT VIOLATION: ${name} kept the host value ${HOST_SENTINELS[name]}`
        )
        if (actual === undefined) {
          evidence(`case 5 ${name}: absent`)
          continue
        }
        assert.equal(typeof actual, 'string')
        if (typeof actual !== 'string') continue
        const activation = env.metadata.activation.set[name]
        if (name === 'CONDA_PREFIX') {
          assert.ok(
            samePath(actual, env.prefix),
            `CONTRACT VIOLATION: CONDA_PREFIX=${actual} is not the env prefix ${env.prefix}`
          )
          evidence(`case 5 CONDA_PREFIX: equals prefix ${actual}`)
          continue
        }
        assert.equal(
          actual,
          activation,
          `CONTRACT VIOLATION: ${name}=${actual} is not an activation value (${activation ?? 'absent'})`
        )
        evidence(`case 5 ${name}: activation value`)
      }
    })

    test('6. caches stay under the runtime cache and do not touch the prefix or HOME', async () => {
      const env = requirePython()
      const home = mkdtempSync(join(scratchDir(), 'cache-home-'))
      writeFileSync(join(home, 'phi-created.txt'), 'created by the test\n')
      const pythonBin = join(env.prefix, 'bin', 'python')
      const control = runDirect(
        pythonBin,
        [
          '-c',
          'from pathlib import Path; Path.home().joinpath("phi-control-write.txt").write_text("visible")'
        ],
        directEnv({ HOME: home })
      )
      const controlFile = join(home, 'phi-control-write.txt')
      const controlOk = control.status === 0 && existsSync(controlFile)
      assertControl(
        'case 6 HOME writes are observable',
        controlOk,
        `exit=${control.status} error=${control.error ?? ''} stdout=${clip(control.stdout)} stderr=${clip(control.stderr)}`
      )
      unlinkSync(controlFile)

      const beforeHome = listTree(home)
      const beforePrefix = listTree(env.prefix)
      const printCaches =
        'import json, os\n' +
        'keys = ["MPLCONFIGDIR", "NUMBA_CACHE_DIR", "XDG_CACHE_HOME"]\n' +
        'print(json.dumps({key: os.environ.get(key) for key in keys}))\n'
      const printed = await runIsolated(env, ['python', '-c', printCaches], {
        ...process.env,
        HOME: home
      })
      assert.equal(printed.exitCode, 0, clip(printed.stderr))
      const values = parseJson(printed.stdout)
      assert.equal(typeof values, 'object')
      assert.ok(values !== null && !Array.isArray(values))
      const caches = values as Record<string, unknown>
      const cacheRoot = cacheDir(env)
      const expected: Record<string, string> = {
        MPLCONFIGDIR: join(cacheRoot, 'matplotlib'),
        NUMBA_CACHE_DIR: join(cacheRoot, 'numba'),
        XDG_CACHE_HOME: join(cacheRoot, 'xdg')
      }
      for (const [name, expectedPath] of Object.entries(expected)) {
        const actual = caches[name]
        assert.equal(typeof actual, 'string', `${name} missing`)
        if (typeof actual !== 'string') continue
        assert.ok(isInside(actual, cacheRoot), `${name}=${actual} is not under ${cacheRoot}`)
        assert.ok(samePath(actual, expectedPath), `${name}=${actual} expected ${expectedPath}`)
        assert.equal(existsSync(actual), true, `${name} directory does not exist: ${actual}`)
      }
      evidence(
        `case 6 caches: MPLCONFIGDIR=${String(caches.MPLCONFIGDIR)} NUMBA_CACHE_DIR=${String(caches.NUMBA_CACHE_DIR)} XDG_CACHE_HOME=${String(caches.XDG_CACHE_HOME)}`
      )

      const writeProbes =
        'import os\n' +
        'from pathlib import Path\n' +
        'for key in ("MPLCONFIGDIR", "NUMBA_CACHE_DIR", "XDG_CACHE_HOME"):\n' +
        '    path = Path(os.environ[key])\n' +
        '    path.mkdir(parents=True, exist_ok=True)\n' +
        '    (path / "phi-isolation-probe").write_text("probe")\n' +
        'print("wrote")\n'
      const wrote = await runIsolated(env, ['python', '-c', writeProbes], {
        ...process.env,
        HOME: home
      })
      assert.equal(wrote.exitCode, 0, clip(wrote.stderr))
      const bytecode = await runIsolated(
        env,
        ['python', '-c', 'import sys; print(sys.dont_write_bytecode)'],
        { ...process.env, HOME: home }
      )
      assert.equal(bytecode.exitCode, 0, clip(bytecode.stderr))
      for (const dir of Object.values(expected)) {
        assert.equal(existsSync(join(dir, 'phi-isolation-probe')), true, `missing probe in ${dir}`)
      }
      assertSameTree('prefix during cache commands', beforePrefix, listTree(env.prefix))
      assertSameTree('temp HOME during cache commands', beforeHome, listTree(home))
    })

    test('7. R.home and library paths are inside the prefix', async () => {
      const env = requireR()
      const code =
        'writeLines(paste0("RHOME=", R.home()))\nwriteLines(paste0("LIB=", .libPaths()))\n'
      const result = await runIsolated(env, ['Rscript', '-e', code], { ...process.env })
      assert.equal(result.exitCode, 0, clip(`${result.stdout}\n${result.stderr}`, 1200))
      const homes = linesWithPrefix(result.stdout, 'RHOME=')
      const libs = linesWithPrefix(result.stdout, 'LIB=')
      assert.equal(homes.length, 1, clip(result.stdout))
      assert.ok(libs.length > 0, clip(result.stdout))
      const rHome = homes[0] ?? ''
      assert.ok(isInside(rHome, env.prefix), `R.home() outside prefix: ${rHome}`)
      for (const lib of libs) {
        assert.ok(
          isInside(lib, env.prefix),
          `CONTRACT VIOLATION: .libPaths() outside prefix: ${lib}`
        )
      }
      assert.ok(
        isInside(result.resolvedCommand, env.prefix),
        `resolvedCommand outside prefix: ${result.resolvedCommand}`
      )
      evidence(
        `case 7 control: not applicable; R.home=${rHome} libPaths=${libs.join(',')} resolvedCommand=${result.resolvedCommand}`
      )
    })

    test('8. ~/.Rprofile is not read', async () => {
      const env = requireR()
      const home = mkdtempSync(join(scratchDir(), 'rprofile-home-'))
      const extraLib = mkdtempSync(join(scratchDir(), 'rprofile-lib-'))
      writeFileSync(
        join(home, '.Rprofile'),
        `phi_rprofile_marker <- TRUE\n.libPaths(c(${rString(extraLib)}, .libPaths()))\n`
      )
      const code = [
        'writeLines(paste0("MARKER=", if (exists("phi_rprofile_marker", envir = .GlobalEnv)) "TRUE" else "FALSE"))',
        'writeLines(paste0("LIB=", .libPaths()))'
      ].join('\n')
      const rscript = join(env.prefix, 'bin', 'Rscript')
      const controlEnvironment = directEnv({ HOME: home })
      assert.equal(controlEnvironment.R_PROFILE_USER, undefined)
      const control = runDirect(rscript, ['-e', code], controlEnvironment)
      const controlMarker = linesWithPrefix(control.stdout, 'MARKER=')[0]
      const controlLibs = linesWithPrefix(control.stdout, 'LIB=')
      const controlOk =
        control.status === 0 &&
        controlMarker === 'TRUE' &&
        controlLibs.some((lib) => samePath(lib, extraLib))
      assertControl(
        'case 8 Rprofile',
        controlOk,
        `exit=${control.status} error=${control.error ?? ''} stdout=${clip(control.stdout)} stderr=${clip(control.stderr)}`
      )

      const isolated = await runIsolated(env, ['Rscript', '-e', code], {
        ...process.env,
        HOME: home
      })
      assert.equal(isolated.exitCode, 0, clip(`${isolated.stdout}\n${isolated.stderr}`, 1200))
      const marker = linesWithPrefix(isolated.stdout, 'MARKER=')[0]
      const libs = linesWithPrefix(isolated.stdout, 'LIB=')
      evidence(`case 8 Rprofile isolated: MARKER=${marker ?? ''} libs=${libs.join(',')}`)
      assert.equal(marker, 'FALSE', 'CONTRACT VIOLATION: ~/.Rprofile set phi_rprofile_marker')
      assert.equal(
        libs.some((lib) => samePath(lib, extraLib)),
        false,
        `CONTRACT VIOLATION: Rprofile library leaked into .libPaths(): ${libs.join(',')}`
      )
    })

    test('9. R_LIBS_USER is not a library path', async () => {
      const env = requireR()
      const home = mkdtempSync(join(scratchDir(), 'r-libs-home-'))
      const userLib = mkdtempSync(join(scratchDir(), 'r-libs-user-'))
      const code = 'writeLines(paste0("LIB=", .libPaths()))\n'
      const rscript = join(env.prefix, 'bin', 'Rscript')
      const control = runDirect(
        rscript,
        ['-e', code],
        directEnv({ HOME: home, R_LIBS_USER: userLib })
      )
      const controlLibs = linesWithPrefix(control.stdout, 'LIB=')
      const controlOk = control.status === 0 && controlLibs.some((lib) => samePath(lib, userLib))
      assertControl(
        'case 9 R_LIBS_USER',
        controlOk,
        `exit=${control.status} error=${control.error ?? ''} stdout=${clip(control.stdout)} stderr=${clip(control.stderr)}`
      )

      const isolated = await runIsolated(env, ['Rscript', '-e', code], {
        ...process.env,
        HOME: home,
        R_LIBS_USER: userLib
      })
      assert.equal(isolated.exitCode, 0, clip(`${isolated.stdout}\n${isolated.stderr}`, 1200))
      const libs = linesWithPrefix(isolated.stdout, 'LIB=')
      evidence(`case 9 R_LIBS_USER isolated libs=${libs.join(',')}`)
      assert.equal(
        libs.some((lib) => samePath(lib, userLib)),
        false,
        `CONTRACT VIOLATION: R_LIBS_USER ${userLib} is on .libPaths(): ${libs.join(',')}`
      )
    })

    test('10. source packages praise and testit load', async () => {
      const env = requireR()
      const code = 'library(praise)\nlibrary(testit)\nwriteLines("loaded")\n'
      const result = await runIsolated(env, ['Rscript', '-e', code], { ...process.env })
      evidence(
        `case 10 control: not applicable; exit=${result.exitCode} stdout=${clip(result.stdout)} stderr=${clip(result.stderr)}`
      )
      assert.equal(result.exitCode, 0, clip(`${result.stdout}\n${result.stderr}`, 1500))
      assert.match(result.stdout, /^loaded$/m)
      assert.doesNotMatch(result.stderr, /there is no package called/)
    })

    test('11. prefixes stay read-only with no new files', () => {
      const python = requirePython()
      const r = requireR()
      const pythonWritable = writableRegularFiles(python.prefix)
      const rWritable = writableRegularFiles(r.prefix)
      evidence(
        `case 11 control: not applicable; python writable=${pythonWritable.length} r writable=${rWritable.length}`
      )
      assert.deepEqual(
        pythonWritable,
        [],
        `CONTRACT VIOLATION: writable files in python prefix: ${pythonWritable.slice(0, 20).join(', ')}`
      )
      assert.deepEqual(
        rWritable,
        [],
        `CONTRACT VIOLATION: writable files in R prefix: ${rWritable.slice(0, 20).join(', ')}`
      )
      assertSameTree('python prefix after all cases', pythonTree, listTree(python.prefix))
      assertSameTree('R prefix after all cases', rTree, listTree(r.prefix))
    })
  }
)
