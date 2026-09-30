import assert from 'node:assert/strict'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import test from 'node:test'

import { parse } from 'yaml'

import {
  ensureRuntimeLayout,
  getRuntimeRoot,
  micromambaEnvironment,
  renderMambarc,
  runMicromamba,
  writeMambarc
} from '../src/main/agent/envs'
import { getMicromambaPath } from '../src/main/agent/envs/paths'

const MINIMAL_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'
const SLEEP_STUB = '#!/bin/sh\nexec /bin/sleep 30\n'

function bundledMicromambaSkip(): string | false {
  try {
    getMicromambaPath()
    return false
  } catch (error) {
    return error instanceof Error ? error.message : 'bundled micromamba is unavailable'
  }
}

const skipWithoutMicromamba = bundledMicromambaSkip()

async function withTemp(
  prefix: string,
  body: (root: string) => Promise<void> | void
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), `phi-runtime-${prefix}-`))
  try {
    await body(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function writeExecutable(root: string, script: string): string {
  const executable = join(root, 'stub-micromamba')
  writeFileSync(executable, script, { mode: 0o755 })
  chmodSync(executable, 0o755)
  return executable
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

test('getRuntimeRoot joins runtime under the agent directory', () => {
  assert.equal(getRuntimeRoot('/tmp/phi-agent'), join('/tmp/phi-agent', 'runtime'))
})

test('ensureRuntimeLayout creates the five runtime directories and is idempotent', async () => {
  await withTemp('layout', (root) => {
    const layout = ensureRuntimeLayout(root)
    assert.equal(layout.root, root)
    assert.equal(layout.mambarc, join(root, 'mambarc'))
    for (const directory of [layout.envs, layout.pkgs, layout.logs, layout.state, layout.sources]) {
      assert.equal(isAbsolute(directory), true)
      assert.equal(statSync(directory).isDirectory(), true)
    }
    assert.equal(isAbsolute(layout.mambarc), true)

    const again = ensureRuntimeLayout(root)
    assert.deepEqual(again, layout)
    assert.equal(statSync(layout.sources).isDirectory(), true)
  })
})

test('renderMambarc writes channels, mirrors, proxy, and is deterministic', async () => {
  await withTemp('mambarc', (root) => {
    const plain = renderMambarc(root)
    assert.equal(plain, renderMambarc(root, {}))
    assert.equal(renderMambarc(root, { channelMirrors: {}, proxy: {} }), plain)
    const parsed = parse(plain) as {
      channels: string[]
      channel_priority: string
      pkgs_dirs: string[]
      envs_dirs: string[]
      mirrored_channels?: unknown
      proxy_servers?: unknown
    }
    assert.deepEqual(parsed.channels, ['conda-forge', 'bioconda'])
    assert.equal(parsed.channel_priority, 'strict')
    assert.deepEqual(parsed.pkgs_dirs, [join(root, 'pkgs')])
    assert.deepEqual(parsed.envs_dirs, [join(root, 'envs')])
    assert.equal(parsed.mirrored_channels, undefined)
    assert.equal(parsed.proxy_servers, undefined)

    const mirrorUrl = 'https://mirrors.tuna.tsinghua.edu.cn/anaconda/cloud/conda-forge'
    const biocondaUrl = 'https://example.test/bioconda'
    const mirrored = renderMambarc(root, {
      channelMirrors: {
        bioconda: biocondaUrl,
        'conda-forge': mirrorUrl
      }
    })
    const mirroredAgain = renderMambarc(root, {
      channelMirrors: {
        'conda-forge': mirrorUrl,
        bioconda: biocondaUrl
      }
    })
    assert.equal(mirrored, mirroredAgain)
    assert.deepEqual(
      (parse(mirrored) as { mirrored_channels: Record<string, string[]> }).mirrored_channels,
      {
        bioconda: [biocondaUrl],
        'conda-forge': [mirrorUrl]
      }
    )

    const proxy = {
      http: 'http://proxy.example:80',
      https: 'http://proxy.example:443'
    }
    const withProxy = renderMambarc(root, { proxy })
    const withProxySwapped = renderMambarc(root, {
      proxy: { https: proxy.https, http: proxy.http }
    })
    assert.equal(withProxy, withProxySwapped)
    assert.equal(withProxy, renderMambarc(root, { proxy }))
    assert.deepEqual(
      (parse(withProxy) as { proxy_servers: { http: string; https: string } }).proxy_servers,
      proxy
    )
  })
})

test('writeMambarc writes once and again only when the content changes', async () => {
  await withTemp('write-mambarc', (root) => {
    const mirror = {
      channelMirrors: {
        'conda-forge': 'https://mirrors.tuna.tsinghua.edu.cn/anaconda/cloud/conda-forge'
      }
    }
    assert.equal(writeMambarc(root), true)
    assert.equal(readFileSync(join(root, 'mambarc'), 'utf8'), renderMambarc(root))
    assert.equal(writeMambarc(root), false)
    assert.equal(writeMambarc(root, {}), false)
    assert.equal(writeMambarc(root, mirror), true)
    assert.equal(readFileSync(join(root, 'mambarc'), 'utf8'), renderMambarc(root, mirror))
    assert.equal(writeMambarc(root, mirror), false)
    assert.deepEqual(
      readdirSync(root).filter((name) => name.includes('.tmp')),
      []
    )
  })
})

test('micromambaEnvironment keeps, drops, and sets the invocation allowlist', () => {
  const base: NodeJS.ProcessEnv = {
    HOME: '/Users/phi',
    USER: 'phi',
    LOGNAME: 'phi',
    TMPDIR: '/tmp',
    TERM: 'xterm-256color',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'C.UTF-8',
    LC_CTYPE: 'C.UTF-8',
    HTTP_PROXY: 'http://proxy.example:8080',
    HTTPS_PROXY: 'http://proxy.example:8443',
    NO_PROXY: 'localhost',
    http_proxy: 'http://lower.example:8080',
    https_proxy: 'http://lower.example:8443',
    no_proxy: '127.0.0.1',
    SSL_CERT_FILE: '/etc/ssl/cert.pem',
    REQUESTS_CA_BUNDLE: '/etc/ssl/requests.pem',
    CONDA_PREFIX: '/opt/conda',
    CONDARC: '/Users/phi/.condarc',
    MAMBA_EXE: '/opt/conda/bin/micromamba',
    MAMBARC: '/Users/phi/.mambarc',
    MAMBA_ROOT_PREFIX: '/wrong-root',
    PYTHONPATH: '/tmp/python',
    PYTHONHOME: '/tmp/python-home',
    VIRTUAL_ENV: '/tmp/venv',
    R_LIBS_USER: '/Users/phi/R',
    LD_LIBRARY_PATH: '/opt/conda/lib',
    DYLD_LIBRARY_PATH: '/opt/homebrew/lib',
    DYLD_FALLBACK_LIBRARY_PATH: '/opt/homebrew/lib',
    FOO: 'bar',
    PATH: '/usr/local/bin:/opt/homebrew/bin',
    TERM_PROGRAM: 'ghost'
  }

  assert.deepEqual(micromambaEnvironment('/runtime', base), {
    HOME: '/Users/phi',
    USER: 'phi',
    LOGNAME: 'phi',
    TMPDIR: '/tmp',
    TERM: 'xterm-256color',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'C.UTF-8',
    LC_CTYPE: 'C.UTF-8',
    HTTP_PROXY: 'http://proxy.example:8080',
    HTTPS_PROXY: 'http://proxy.example:8443',
    NO_PROXY: 'localhost',
    http_proxy: 'http://lower.example:8080',
    https_proxy: 'http://lower.example:8443',
    no_proxy: '127.0.0.1',
    SSL_CERT_FILE: '/etc/ssl/cert.pem',
    REQUESTS_CA_BUNDLE: '/etc/ssl/requests.pem',
    PATH: MINIMAL_PATH,
    MAMBA_ROOT_PREFIX: '/runtime',
    MAMBA_NO_BANNER: '1'
  })
})

test('runMicromamba pins the rc file, root prefix, and --no-env', async () => {
  await withTemp('argv', async (root) => {
    const executable = writeExecutable(
      root,
      [
        '#!/bin/sh',
        'printf \'%s\\n\' "$@" > argv.txt',
        'printf \'%s\' "$PATH" > path.txt',
        'printf \'%s\' "$MAMBA_ROOT_PREFIX" > root-prefix.txt',
        'printf \'%s\' "$MAMBA_NO_BANNER" > banner.txt',
        'printf \'%s\' "${CONDA_PREFIX-unset}" > conda.txt',
        'printf \'%s\' "${FOO-unset}" > foo.txt',
        'exit 0',
        ''
      ].join('\n')
    )
    const result = await runMicromamba(['info', '--json'], {
      root,
      executable,
      baseEnv: {
        HOME: '/Users/phi',
        CONDA_PREFIX: '/opt/conda',
        FOO: 'bar',
        PATH: '/evil'
      }
    })
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(readFileSync(join(root, 'argv.txt'), 'utf8').split('\n').slice(0, -1), [
      '--rc-file',
      join(root, 'mambarc'),
      '--no-env',
      '--root-prefix',
      root,
      'info',
      '--json'
    ])
    assert.equal(readFileSync(join(root, 'path.txt'), 'utf8'), MINIMAL_PATH)
    assert.equal(readFileSync(join(root, 'root-prefix.txt'), 'utf8'), root)
    assert.equal(readFileSync(join(root, 'banner.txt'), 'utf8'), '1')
    assert.equal(readFileSync(join(root, 'conda.txt'), 'utf8'), 'unset')
    assert.equal(readFileSync(join(root, 'foo.txt'), 'utf8'), 'unset')
  })
})

test('runMicromamba rejects when the executable cannot be spawned', async () => {
  await withTemp('spawn', async (root) => {
    const executable = join(root, 'missing-micromamba')
    await assert.rejects(
      () => runMicromamba(['info'], { root, executable }),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /Failed to spawn micromamba/)
        assert.match(error.message, /missing-micromamba/)
        return true
      }
    )
  })
})

test(
  'runMicromamba resolves with code null when the signal aborts',
  { timeout: 10000 },
  async () => {
    await withTemp('abort', async (root) => {
      const executable = writeExecutable(root, SLEEP_STUB)
      const controller = new AbortController()
      const pending = runMicromamba(['sleep'], { root, executable, signal: controller.signal })
      const timer = setTimeout(() => controller.abort(), 50)
      try {
        const result = await withDeadline(pending, 5000)
        assert.equal(result.code, null)
      } finally {
        clearTimeout(timer)
      }
    })
  }
)

test(
  'runMicromamba resolves with code null when the timeout fires',
  { timeout: 10000 },
  async () => {
    await withTemp('timeout', async (root) => {
      const executable = writeExecutable(root, SLEEP_STUB)
      const result = await withDeadline(
        runMicromamba(['sleep'], { root, executable, timeoutMs: 50 }),
        5000
      )
      assert.equal(result.code, null)
    })
  }
)

test(
  'runMicromamba ignores user condarc and mambarc',
  { skip: skipWithoutMicromamba },
  async () => {
    await withTemp('isolate', async (directory) => {
      const home = join(directory, 'home')
      const layout = ensureRuntimeLayout(join(directory, 'runtime'))
      mkdirSync(home)
      const bogus = 'channels:\n  - phi-bogus-channel\n'
      writeFileSync(join(home, '.condarc'), bogus)
      writeFileSync(join(home, '.mambarc'), bogus)
      assert.equal(writeMambarc(layout.root), true)

      let streamed = ''
      const result = await runMicromamba(['config', 'list', '--json'], {
        root: layout.root,
        baseEnv: {
          ...process.env,
          HOME: home,
          CONDARC: join(home, '.condarc'),
          MAMBARC: join(home, '.mambarc')
        },
        onOutput: (chunk) => {
          if (chunk.stream === 'stdout') streamed += chunk.text
        }
      })
      assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`)
      assert.equal(streamed, result.stdout)
      assert.equal(result.stdout.includes('phi-bogus-channel'), false)
      assert.equal(result.stderr.includes('phi-bogus-channel'), false)
      const config = JSON.parse(result.stdout) as { channels?: string[] }
      assert.deepEqual(config.channels, ['conda-forge', 'bioconda'])
    })
  }
)

test(
  'runMicromamba reports the temp runtime root as the root prefix',
  { skip: skipWithoutMicromamba },
  async () => {
    await withTemp('prefix', async (directory) => {
      const home = join(directory, 'home')
      mkdirSync(home)
      const root = ensureRuntimeLayout(join(directory, 'runtime')).root
      assert.equal(writeMambarc(root), true)
      const result = await runMicromamba(['info', '--json'], {
        root,
        baseEnv: { ...process.env, HOME: home }
      })
      assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`)
      const info = JSON.parse(result.stdout) as {
        'base environment': string
        'populated config files': string[]
      }
      assert.equal(realpathSync(info['base environment']), realpathSync(root))
      assert.deepEqual(
        info['populated config files'].map((file) => realpathSync(file)),
        [realpathSync(join(root, 'mambarc'))]
      )
    })
  }
)

test('runMicromamba passes only validated CONDA_OVERRIDE_* variables', async () => {
  await withTemp('overrides', async (root) => {
    const executable = writeExecutable(
      root,
      [
        '#!/bin/sh',
        'printf \'%s|%s|%s\' "${CONDA_OVERRIDE_GLIBC-unset}" "${CONDA_OVERRIDE_OSX-unset}" "${CONDA_OVERRIDE_CUDA-unset}" > overrides.txt',
        'exit 0',
        ''
      ].join('\n')
    )
    const result = await runMicromamba(['info'], {
      root,
      executable,
      baseEnv: { CONDA_OVERRIDE_CUDA: '12.0' },
      condaOverrides: { glibc: '2.17' }
    })
    assert.equal(result.code, 0)
    assert.equal(readFileSync(join(root, 'overrides.txt'), 'utf8'), '2.17|unset|unset')
    await assert.rejects(
      runMicromamba(['info'], { root, executable, condaOverrides: { glibc: '2.17; rm -rf /' } }),
      /invalid conda override/
    )
  })
})
