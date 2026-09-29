import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import {
  EXECUTION_CONTRACT_VERSION,
  environmentVariables,
  loadEnvironment,
  removeEnvironmentCache,
  resolveCommand,
  runInEnvironment,
  sanitizeHostEnvironment,
  type EnvHandle,
  type EnvMetadata
} from '../src/main/agent/envs'

const ENV_ID = 'python-0123456789ab'

function withTemp(prefix: string, body: (root: string) => Promise<void> | void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), `phi-exec-${prefix}-`))
  return Promise.resolve()
    .then(() => body(root))
    .finally(() => {
      rmSync(root, { recursive: true, force: true })
    })
}

function withDeadline<T>(pending: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
    pending.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    )
  })
}

function metadata(envId: string, patch: Partial<EnvMetadata> = {}): EnvMetadata {
  return {
    name: 'python',
    kind: 'base',
    platform: 'darwin-arm64',
    lockSha256: 'a'.repeat(64),
    createdAt: '2026-09-29T00:00:00.000Z',
    micromambaVersion: '2.9.0',
    activation: { set: {}, pathPrepend: [] },
    host: {},
    sourcePackages: [],
    status: 'ready',
    contractVersion: '1.0.0',
    ...patch,
    envId
  }
}

function handle(root: string, meta: EnvMetadata): EnvHandle {
  return {
    envId: meta.envId,
    prefix: join(root, 'envs', meta.envId),
    metadata: meta
  }
}

function runnable(root: string, envId = ENV_ID): EnvHandle {
  const prefix = join(root, 'envs', envId)
  return handle(
    root,
    metadata(envId, {
      activation: {
        set: { CONDA_PREFIX: prefix },
        pathPrepend: [join(prefix, 'bin')]
      }
    })
  )
}

function writeScript(env: EnvHandle, name: string, body: string): string {
  const file = join(env.prefix, 'bin', name)
  mkdirSync(dirname(file), { recursive: true })
  const script = body.startsWith('#!') ? body : `#!/bin/sh\n${body}`
  writeFileSync(file, script.endsWith('\n') ? script : `${script}\n`, { mode: 0o755 })
  chmodSync(file, 0o755)
  return file
}

function assertError(error: unknown, pattern: RegExp): boolean {
  assert.ok(error instanceof Error)
  assert.match(error.message, pattern)
  return true
}

test('EXECUTION_CONTRACT_VERSION is 1.0.0', () => {
  assert.equal(EXECUTION_CONTRACT_VERSION, '1.0.0')
})

test('sanitizeHostEnvironment keeps the allowlist and drops everything else', () => {
  const sanitized = sanitizeHostEnvironment({
    PATH: '/usr/local/bin',
    PYTHONPATH: '/tmp/python',
    CONDA_PREFIX: '/opt/conda',
    R_LIBS_USER: '/Users/phi/R',
    JAVA_HOME: '/opt/homebrew/opt/java',
    DYLD_LIBRARY_PATH: '/opt/homebrew/lib',
    LC_ALL: 'en_US.UTF-8',
    LC_CTYPE: 'en_US.UTF-8',
    https_proxy: 'http://proxy.example:8080',
    http_proxy: 'http://proxy.example:8080',
    SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
    TZ: 'UTC',
    FOO: 'bar',
    HOME: undefined
  })
  assert.deepEqual(sanitized, {
    LC_ALL: 'en_US.UTF-8',
    LC_CTYPE: 'en_US.UTF-8',
    https_proxy: 'http://proxy.example:8080',
    http_proxy: 'http://proxy.example:8080',
    SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
    TZ: 'UTC'
  })
})

test('environmentVariables applies sources in order and builds an isolated PATH', async () => {
  await withTemp('vars', (root) => {
    const envId = 'viz-0123456789ab'
    const prefix = join(root, 'envs', envId)
    const bin = join(prefix, 'bin')
    const shared = join(root, 'host-bin')
    const env = handle(
      root,
      metadata(envId, {
        activation: {
          set: {
            HOME: '/activation-home',
            CONDA_PREFIX: prefix,
            PYTHONNOUSERSITE: '0'
          },
          pathPrepend: [bin, bin, shared, '/usr/bin']
        },
        host: {
          soffice: '/opt/libreoffice/program/soffice',
          magick: join(shared, 'magick')
        }
      })
    )
    const variables = environmentVariables(env, {
      baseEnv: {
        HOME: '/Users/phi',
        USER: 'phi',
        https_proxy: 'http://proxy.example:8080',
        LANG: 'C',
        PATH: '/evil/bin',
        PYTHONPATH: '/evil/python',
        CONDA_PREFIX: '/opt/conda',
        FOO: 'bar',
        DYLD_LIBRARY_PATH: '/opt/homebrew/lib',
        SSH_AUTH_SOCK: '/tmp/ssh-agent.sock'
      },
      extraEnv: {
        OMICS_VISUALIZATION_SKILL_ROOT: '/skills/viz',
        HOME: '/extra-home'
      },
      platform: 'darwin'
    })

    assert.deepEqual(Object.keys(variables), [
      'HOME',
      'USER',
      'https_proxy',
      'LANG',
      'SSH_AUTH_SOCK',
      'CONDA_PREFIX',
      'PYTHONNOUSERSITE',
      'PYTHONDONTWRITEBYTECODE',
      'R_LIBS_USER',
      'R_LIBS_SITE',
      'R_PROFILE_USER',
      'R_ENVIRON_USER',
      'MPLBACKEND',
      'MPLCONFIGDIR',
      'NUMBA_CACHE_DIR',
      'XDG_CACHE_HOME',
      'PHI_ENV_ID',
      'PHI_ENV_PREFIX',
      'LC_ALL',
      'OMICS_VISUALIZATION_SKILL_ROOT',
      'PATH'
    ])
    assert.equal(variables.HOME, '/extra-home')
    assert.equal(variables.CONDA_PREFIX, prefix)
    assert.equal(variables.PYTHONNOUSERSITE, '1')
    assert.equal(variables.PYTHONDONTWRITEBYTECODE, '1')
    assert.equal(variables.R_LIBS_USER, join(prefix, 'lib', 'R', 'library'))
    assert.equal(variables.R_LIBS_SITE, join(prefix, 'lib', 'R', 'library'))
    assert.equal(variables.R_PROFILE_USER, '/dev/null')
    assert.equal(variables.R_ENVIRON_USER, '/dev/null')
    assert.equal(variables.MPLBACKEND, 'Agg')
    const cache = join(root, 'cache', envId)
    assert.equal(variables.MPLCONFIGDIR, join(cache, 'matplotlib'))
    assert.equal(variables.NUMBA_CACHE_DIR, join(cache, 'numba'))
    assert.equal(variables.XDG_CACHE_HOME, join(cache, 'xdg'))
    assert.equal(variables.PHI_ENV_ID, envId)
    assert.equal(variables.PHI_ENV_PREFIX, prefix)
    assert.equal(variables.LC_ALL, 'en_US.UTF-8')
    assert.equal(variables.OMICS_VISUALIZATION_SKILL_ROOT, '/skills/viz')
    assert.equal(variables.PYTHONPATH, undefined)
    assert.equal(variables.FOO, undefined)
    assert.equal(variables.DYLD_LIBRARY_PATH, undefined)
    assert.equal(
      variables.PATH,
      [bin, shared, '/usr/bin', '/opt/libreoffice/program', '/bin', '/usr/sbin', '/sbin'].join(':')
    )
    for (const name of ['matplotlib', 'numba', 'xdg']) {
      assert.equal(statSync(join(cache, name)).isDirectory(), true)
    }

    const linux = environmentVariables(env, { baseEnv: { LANG: 'C' }, platform: 'linux' })
    assert.equal(linux.LC_ALL, 'C.UTF-8')
    const utf8 = environmentVariables(env, {
      baseEnv: { LANG: 'en_US.UTF-8' },
      platform: 'linux'
    })
    assert.equal(utf8.LC_ALL, undefined)
    assert.equal(utf8.LANG, 'en_US.UTF-8')
    const ctype = environmentVariables(env, {
      baseEnv: { LC_CTYPE: 'C.utf8', LANG: 'C' },
      platform: 'darwin'
    })
    assert.equal(ctype.LC_ALL, undefined)

    for (const key of ['PATH', 'PYTHONPATH', 'R_HOME', 'CONDA_X', 'DYLD_X', 'PHI_ENV_ID']) {
      assert.throws(
        () => environmentVariables(env, { baseEnv: {}, extraEnv: { [key]: 'nope' } }),
        (error: unknown) => assertError(error, new RegExp(`extraEnv cannot set ${key}`))
      )
    }
  })
})

test('removeEnvironmentCache deletes the environment cache and ignores a missing one', async () => {
  await withTemp('cache', (root) => {
    const env = handle(root, metadata(ENV_ID))
    const cache = join(root, 'cache', ENV_ID)
    environmentVariables(env, { baseEnv: {}, platform: 'linux' })
    assert.equal(statSync(cache).isDirectory(), true)
    removeEnvironmentCache(root, ENV_ID)
    assert.equal(existsSync(cache), false)
    removeEnvironmentCache(root, ENV_ID)
  })
})

test('resolveCommand searches PATH, skips non-executables, and returns undefined when missing', async () => {
  await withTemp('resolve', (root) => {
    const first = join(root, 'first')
    const second = join(root, 'second')
    mkdirSync(first)
    mkdirSync(second)
    const skipped = join(first, 'tool')
    const found = join(second, 'tool')
    writeFileSync(skipped, '#!/bin/sh\nexit 0\n', { mode: 0o644 })
    chmodSync(skipped, 0o644)
    writeFileSync(found, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    chmodSync(found, 0o755)

    assert.equal(resolveCommand('tool', `${first}:${second}`), found)
    assert.equal(resolveCommand('missing', `${first}:${second}`), undefined)
    assert.equal(resolveCommand(skipped, second), undefined)
    assert.equal(resolveCommand(found, first), found)
  })
})

test('runInEnvironment captures status, streams, and arguments without a shell', async () => {
  await withTemp('run', async (root) => {
    const env = runnable(root)
    const script = writeScript(
      env,
      'speak',
      "#!/bin/sh\nprintf 'hello-out %s\\n' \"$1\"\nprintf 'hello-err\\n' >&2\nexit 4\n"
    )
    let stdout = ''
    let stderr = ''
    const result = await runInEnvironment(env, ['speak', 'a b; echo pwned'], {
      cwd: root,
      baseEnv: { HOME: '/Users/phi' },
      onOutput: (chunk) => {
        if (chunk.stream === 'stdout') stdout += chunk.text
        else stderr += chunk.text
      }
    })
    assert.equal(result.envId, ENV_ID)
    assert.deepEqual(result.argv, ['speak', 'a b; echo pwned'])
    assert.equal(result.resolvedCommand, script)
    assert.equal(result.cwd, root)
    assert.equal(result.exitCode, 4)
    assert.equal(result.signal, null)
    assert.equal(result.terminated, undefined)
    assert.equal(result.stdout, 'hello-out a b; echo pwned\n')
    assert.equal(result.stderr, 'hello-err\n')
    assert.equal(stdout, result.stdout)
    assert.equal(stderr, result.stderr)
    assert.deepEqual(result.truncated, { stdout: false, stderr: false })
    assert.equal(typeof result.durationMs, 'number')
    assert.ok(result.durationMs >= 0)
  })
})

test('runInEnvironment writes stdin to the child', async () => {
  await withTemp('stdin', async (root) => {
    const env = runnable(root)
    writeScript(env, 'cat-stdin', '#!/bin/sh\ncat\n')
    const result = await runInEnvironment(env, ['cat-stdin'], {
      cwd: root,
      stdin: 'hello-stdin\n',
      baseEnv: {}
    })
    assert.equal(result.exitCode, 0)
    assert.equal(result.stdout, 'hello-stdin\n')
  })
})

test('runInEnvironment truncates captured streams and still streams the full chunks', async () => {
  await withTemp('trunc', async (root) => {
    const env = runnable(root)
    writeScript(
      env,
      'flood',
      [
        '#!/bin/sh',
        'i=0',
        'while [ "$i" -lt 40 ]; do',
        '  printf A',
        '  i=$((i + 1))',
        'done',
        "printf 'xyz' >&2",
        ''
      ].join('\n')
    )
    let stdout = ''
    let stderr = ''
    const result = await runInEnvironment(env, ['flood'], {
      cwd: root,
      maxOutputBytes: 10,
      baseEnv: {},
      onOutput: (chunk) => {
        if (chunk.stream === 'stdout') stdout += chunk.text
        else stderr += chunk.text
      }
    })
    assert.equal(result.stdout, 'A'.repeat(10))
    assert.equal(result.truncated.stdout, true)
    assert.equal(stdout, 'A'.repeat(40))
    assert.equal(result.stderr, 'xyz')
    assert.equal(result.truncated.stderr, false)
    assert.equal(stderr, 'xyz')
  })
})

test('runInEnvironment terminates on timeout', { timeout: 15000 }, async () => {
  await withTemp('timeout', async (root) => {
    const env = runnable(root)
    writeScript(env, 'sleep', '#!/bin/sh\nexec /bin/sleep 30\n')
    const result = await withDeadline(
      runInEnvironment(env, ['sleep'], { cwd: root, timeoutMs: 50, baseEnv: {} }),
      8000
    )
    assert.equal(result.terminated, 'timeout')
    assert.equal(result.exitCode, null)
    assert.equal(result.signal, 'SIGTERM')
    assert.ok(result.durationMs < 4500)
  })
})

test('runInEnvironment terminates on abort', { timeout: 15000 }, async () => {
  await withTemp('abort', async (root) => {
    const env = runnable(root)
    writeScript(env, 'sleep', '#!/bin/sh\nexec /bin/sleep 30\n')
    const controller = new AbortController()
    const pending = runInEnvironment(env, ['sleep'], {
      cwd: root,
      signal: controller.signal,
      baseEnv: {}
    })
    const timer = setTimeout(() => controller.abort(), 50)
    try {
      const result = await withDeadline(pending, 8000)
      assert.equal(result.terminated, 'aborted')
      assert.equal(result.exitCode, null)
      assert.equal(result.signal, 'SIGTERM')
      assert.ok(result.durationMs < 4500)
    } finally {
      clearTimeout(timer)
    }
  })
})

test('runInEnvironment fails before spawn when the command or cwd is missing', async () => {
  await withTemp('missing', async (root) => {
    const env = runnable(root)
    const file = join(root, 'not-a-directory')
    writeFileSync(file, 'x')
    await assert.rejects(
      () => runInEnvironment(env, ['missing-cmd'], { cwd: root, baseEnv: {} }),
      (error: unknown) =>
        assertError(error, new RegExp(`command not found in environment ${ENV_ID}: missing-cmd`))
    )
    await assert.rejects(
      () => runInEnvironment(env, ['missing-cmd'], { cwd: join(root, 'absent'), baseEnv: {} }),
      (error: unknown) => assertError(error, /cwd is not an existing directory/)
    )
    await assert.rejects(
      () => runInEnvironment(env, ['missing-cmd'], { cwd: file, baseEnv: {} }),
      (error: unknown) => assertError(error, /cwd is not an existing directory/)
    )
  })
})

test('runInEnvironment does not pass host PYTHONPATH to the child', async () => {
  await withTemp('isolate', async (root) => {
    const env = runnable(root)
    writeScript(env, 'show-env', '#!/bin/sh\nexec /usr/bin/env\n')
    const result = await runInEnvironment(env, ['show-env'], {
      cwd: root,
      baseEnv: {
        HOME: '/Users/phi',
        PYTHONPATH: '/evil/python',
        FOO: 'bar',
        PATH: '/evil/bin'
      }
    })
    assert.equal(result.exitCode, 0, result.stderr)
    const child = new Map<string, string>()
    for (const line of result.stdout.split('\n')) {
      if (line.length === 0) continue
      const eq = line.indexOf('=')
      if (eq <= 0) continue
      child.set(line.slice(0, eq), line.slice(eq + 1))
    }
    assert.equal(child.has('PYTHONPATH'), false)
    assert.equal(child.has('FOO'), false)
    assert.equal(child.get('HOME'), '/Users/phi')
    assert.equal(child.get('PHI_ENV_ID'), ENV_ID)
    assert.equal(child.get('PHI_ENV_PREFIX'), env.prefix)
    assert.equal(child.get('PYTHONNOUSERSITE'), '1')
    assert.equal(child.get('MPLBACKEND'), 'Agg')
    assert.equal(child.get('CONDA_PREFIX'), env.prefix)
    assert.equal(child.get('PATH')?.includes('/evil'), false)
    assert.equal(child.get('PATH')?.split(':')[0], join(env.prefix, 'bin'))
  })
})

test('loadEnvironment reads a ready env.json and rejects missing, invalid, and non-ready files', async () => {
  await withTemp('load', (root) => {
    const meta = metadata(ENV_ID, {
      activation: { set: { CONDA_PREFIX: join(root, 'envs', ENV_ID) }, pathPrepend: [] }
    })
    const file = join(root, 'envs', ENV_ID, '.phi', 'env.json')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(meta)}\n`)

    const loaded = loadEnvironment(root, ENV_ID)
    assert.equal(loaded.envId, ENV_ID)
    assert.equal(loaded.prefix, join(root, 'envs', ENV_ID))
    assert.deepEqual(loaded.metadata, meta)

    assert.throws(
      () => loadEnvironment(root, 'other-0123456789ab'),
      (error: unknown) => assertError(error, /metadata is missing/)
    )

    writeFileSync(file, '{')
    assert.throws(
      () => loadEnvironment(root, ENV_ID),
      (error: unknown) => assertError(error, /invalid JSON/)
    )

    writeFileSync(file, JSON.stringify({ status: 'ready' }))
    assert.throws(
      () => loadEnvironment(root, ENV_ID),
      (error: unknown) => assertError(error, /metadata is invalid/)
    )

    writeFileSync(file, JSON.stringify({ ...meta, status: 'building' }))
    assert.throws(
      () => loadEnvironment(root, ENV_ID),
      (error: unknown) => assertError(error, /not ready \(status: building\)/)
    )
  })
})

test('termination also stops grandchildren', { timeout: 20000 }, async () => {
  await withTemp('grandchild', async (root) => {
    const env = runnable(root)
    const pidFile = join(root, 'grandchild.pid')
    writeScript(env, 'spawner', `#!/bin/sh\n/bin/sleep 30 &\necho $! > '${pidFile}'\nwait\n`)
    // Abort once the grandchild exists. A fixed short timeout is not reliable: macOS
    // checks a freshly written executable before its first run, which can take ~1 s.
    const controller = new AbortController()
    const pending = runInEnvironment(env, ['spawner'], {
      cwd: root,
      signal: controller.signal,
      baseEnv: {}
    })
    for (let attempt = 0; attempt < 100 && !existsSync(pidFile); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.ok(existsSync(pidFile), 'spawner wrote the grandchild pid')
    await new Promise((resolve) => setTimeout(resolve, 100))
    controller.abort()
    const result = await withDeadline(pending, 10000)
    assert.equal(result.terminated, 'aborted')
    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    assert.ok(pid > 0)
    let alive = true
    for (let attempt = 0; attempt < 30 && alive; attempt += 1) {
      try {
        process.kill(pid, 0)
        await new Promise((resolve) => setTimeout(resolve, 100))
      } catch {
        alive = false
      }
    }
    assert.equal(alive, false, `grandchild ${pid} is still running`)
  })
})
