import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { WorkspaceGitService } from '../src/main/agent/git/workspace-git'
import { LocalHost } from '../src/main/agent/workspace-host/local-host'
import type {
  HostCommand,
  RunCommandOptions,
  WorkspaceHost
} from '../src/main/agent/workspace-host/types'

const execFileAsync = promisify(execFile)

function hostReturning(
  stdout: string,
  calls: Array<{ command: HostCommand; options: RunCommandOptions }>
): WorkspaceHost {
  return hostWithResult({ stdout, stderr: '', code: 0, signal: null, truncated: false }, calls)
}

function hostWithResult(
  result: Awaited<ReturnType<WorkspaceHost['exec']['run']>>,
  calls: Array<{ command: HostCommand; options: RunCommandOptions }>
): WorkspaceHost {
  return {
    fs: {} as WorkspaceHost['fs'],
    exec: {
      async run(command, options) {
        calls.push({ command, options })
        return result
      },
      async spawnBackground() {
        throw new Error('not used')
      }
    },
    capabilities: () =>
      ({
        toolchain: { git: { state: 'available' } }
      }) as ReturnType<WorkspaceHost['capabilities']>
  }
}

function hostThrowing(error: Error & { code?: string }): WorkspaceHost {
  return {
    fs: {} as WorkspaceHost['fs'],
    exec: {
      async run() {
        throw error
      },
      async spawnBackground() {
        throw new Error('not used')
      }
    },
    capabilities: () =>
      ({
        toolchain: { git: { state: 'available' } }
      }) as ReturnType<WorkspaceHost['capabilities']>
  }
}

test('summary reads branch and dirty state in one bounded WorkspaceHost call', async () => {
  const calls: Array<{ command: HostCommand; options: RunCommandOptions }> = []
  const host = hostReturning(
    '# branch.oid 0123456789abcdef0123456789abcdef01234567\0# branch.head main\0? notes.txt\0',
    calls
  )

  const result = await new WorkspaceGitService(host, '/remote/project').summary()

  assert.deepEqual(result, {
    state: 'available',
    branch: 'main',
    dirty: true,
    detached: false,
    headOid: '0123456789abcdef0123456789abcdef01234567'
  })
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].command.slice(4), [
    'status',
    '--porcelain=v2',
    '--branch',
    '-z',
    '--untracked-files=normal',
    '--no-renames'
  ])
  assert.deepEqual(calls[0].command.slice(0, 2), ['/bin/sh', '-c'])
  assert.match(calls[0].command[2], /\/usr\/bin\/env -i PATH=/)
  assert.match(calls[0].command[2], /git_command --no-pager/)
  assert.match(calls[0].command[2], /core\.excludesFile=\/dev\/null/)
  assert.doesNotMatch(calls[0].command[2], /safe\.directory|--global/)
  assert.equal(calls[0].options.cwd, '/remote/project')
  assert.equal(calls[0].options.timeoutMs, 15_000)
  assert.equal(calls[0].options.maxOutputBytes, 2 * 1024 * 1024)
  assert.equal(calls[0].options.env?.GIT_NO_LAZY_FETCH, '1')
})

test('summary reports a missing Git executable without treating the project as clean', async () => {
  const calls: Array<{ command: HostCommand; options: RunCommandOptions }> = []
  const host = hostWithResult(
    {
      stdout: '',
      stderr: 'git: command not found: /private/secret/git',
      code: 127,
      signal: null,
      truncated: false
    },
    calls
  )

  const result = await new WorkspaceGitService(host, '/remote/project').summary()

  assert.deepEqual(result, {
    state: 'unavailable',
    reason: 'git-unavailable',
    message: 'Git 不可用：服务器或本机未安装 Git。'
  })
  assert.equal(calls.length, 1)
})

test('summary distinguishes a directory that is not a Git repository', async () => {
  const host = hostWithResult(
    {
      stdout: '',
      stderr: 'fatal: not a git repository (or any parent up to mount point /private/secret)',
      code: 128,
      signal: null,
      truncated: false
    },
    []
  )

  const result = await new WorkspaceGitService(host, '/remote/project').summary()

  assert.deepEqual(result, {
    state: 'unavailable',
    reason: 'not-repository',
    message: 'Git 不可用：项目目录不是 Git 仓库。'
  })
})

test('summary refuses dubious ownership without exposing or trusting the repository path', async () => {
  const host = hostWithResult(
    {
      stdout: '',
      stderr:
        "fatal: detected dubious ownership in repository at '/private/secret/repository'\n" +
        'To add an exception, call: git config --global --add safe.directory /private/secret/repository',
      code: 128,
      signal: null,
      truncated: false
    },
    []
  )

  const result = await new WorkspaceGitService(host, '/remote/project').summary()

  assert.deepEqual(result, {
    state: 'unavailable',
    reason: 'dubious-ownership',
    message: 'Git 不可用：仓库所有权不安全；Phi 未添加 safe.directory 信任。'
  })
  assert.doesNotMatch(JSON.stringify(result), /private\/secret|--global/)
})

test('summary reports the 15 second timeout as a recoverable NFS-aware degradation', async () => {
  const host = hostWithResult(
    {
      stdout: '',
      stderr: 'operation referenced /private/secret',
      code: null,
      signal: 'SIGKILL',
      truncated: true,
      stderrTruncated: true
    },
    []
  )

  const result = await new WorkspaceGitService(host, '/remote/project').summary()

  assert.deepEqual(result, {
    state: 'unavailable',
    reason: 'timeout',
    message: 'Git 状态读取在 15 秒后超时；远程 NFS 可能较慢，请稍后手动刷新。'
  })
  assert.doesNotMatch(JSON.stringify(result), /private\/secret/)
})

test('summary never treats truncated status output as a clean repository', async () => {
  const host = hostWithResult(
    {
      stdout: '# branch.oid 0123456789abcdef\0# branch.head main\0',
      stderr: '',
      code: 0,
      signal: null,
      truncated: true,
      stdoutTruncated: true
    },
    []
  )

  const result = await new WorkspaceGitService(host, '/remote/project').summary()

  assert.deepEqual(result, {
    state: 'unavailable',
    reason: 'output-truncated',
    message: 'Git 状态输出超过 2 MiB 上限；无法可靠判断工作区状态。'
  })
})

test('summary maps an executable spawn failure to the same bounded missing-Git result', async () => {
  const error = Object.assign(new Error('spawn git ENOENT /private/secret'), { code: 'ENOENT' })

  const result = await new WorkspaceGitService(hostThrowing(error), '/remote/project').summary()

  assert.deepEqual(result, {
    state: 'unavailable',
    reason: 'git-unavailable',
    message: 'Git 不可用：服务器或本机未安装 Git。'
  })
  assert.doesNotMatch(JSON.stringify(result), /private\/secret/)
})

test('summary rejects malformed porcelain output instead of inventing detached clean state', async () => {
  const host = hostReturning('unexpected localized output\0', [])

  const result = await new WorkspaceGitService(host, '/remote/project').summary()

  assert.deepEqual(result, {
    state: 'unavailable',
    reason: 'invalid-output',
    message: 'Git 返回了无法识别的状态数据。'
  })
})

test('summary rejects untrusted branch metadata instead of returning server text', async () => {
  const host = hostReturning('# branch.oid /private/secret\0# branch.head main\0', [])

  const result = await new WorkspaceGitService(host, '/remote/project').summary()

  assert.deepEqual(result, {
    state: 'unavailable',
    reason: 'invalid-output',
    message: 'Git 返回了无法识别的状态数据。'
  })
  assert.doesNotMatch(JSON.stringify(result), /private\/secret/)
})

test('summary clears inherited repository overrides before LocalHost starts Git', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phi-git-env-'))
  const previousGitDir = process.env.GIT_DIR
  try {
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: root })
    process.env.GIT_DIR = '/private/secret/repository'
    const canonicalRoot = await realpath(root)

    const result = await new WorkspaceGitService(
      new LocalHost(canonicalRoot),
      canonicalRoot
    ).summary()

    assert.deepEqual(result, {
      state: 'available',
      branch: 'main',
      dirty: false,
      detached: false
    })
  } finally {
    if (previousGitDir === undefined) delete process.env.GIT_DIR
    else process.env.GIT_DIR = previousGitDir
    await rm(root, { recursive: true, force: true })
  }
})

test('summary never resolves Git from the authorized project directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phi-git-path-'))
  const sentinel = join(root, 'project-git-ran')
  const fakeGit = join(root, 'git')
  const previousPath = process.env.PATH
  try {
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: root })
    await writeFile(fakeGit, `#!/bin/sh\ntouch '${sentinel}'\nexit 127\n`, 'utf8')
    await chmod(fakeGit, 0o755)
    const canonicalRoot = await realpath(root)
    process.env.PATH = `${canonicalRoot}:${previousPath ?? ''}`

    const result = await new WorkspaceGitService(
      new LocalHost(canonicalRoot),
      canonicalRoot
    ).summary()

    assert.equal(result.state, 'available')
    await assert.rejects(access(sentinel))
  } finally {
    process.env.PATH = previousPath
    await rm(root, { recursive: true, force: true })
  }
})

test('summary never discovers a parent repository outside the authorized project root', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'phi:git-parent-boundary-'))
  const project = join(parent, 'authorized-project')
  try {
    await execFileAsync('git', ['init', '-b', 'outside-branch'], { cwd: parent })
    await mkdir(project)
    const canonicalProject = await realpath(project)

    const result = await new WorkspaceGitService(
      new LocalHost(canonicalProject),
      canonicalProject
    ).summary()

    assert.deepEqual(result, {
      state: 'unavailable',
      reason: 'not-repository',
      message: 'Git 不可用：项目目录不是 Git 仓库。'
    })
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})

test('summary rejects repository metadata linked outside the authorized project root', async () => {
  const project = await mkdtemp(join(tmpdir(), 'phi-git-linked-project-'))
  const outside = await mkdtemp(join(tmpdir(), 'phi-git-linked-outside-'))
  try {
    await execFileAsync('git', ['init', '-b', 'external-secret-branch'], { cwd: outside })
    await symlink(join(outside, '.git'), join(project, '.git'), 'dir')
    const canonicalProject = await realpath(project)

    const result = await new WorkspaceGitService(
      new LocalHost(canonicalProject),
      canonicalProject
    ).summary()

    assert.deepEqual(result, {
      state: 'unavailable',
      reason: 'unsafe-repository',
      message: 'Git 不可用：仓库元数据必须位于项目根目录内。'
    })
    assert.doesNotMatch(JSON.stringify(result), /external-secret-branch|linked-outside/)
  } finally {
    await rm(project, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('summary does not execute repository clean filters while checking dirty state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phi-git-filter-'))
  const sentinel = join(root, 'filter-ran')
  const filter = join(root, 'filter.sh')
  try {
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: root })
    await execFileAsync('git', ['config', 'user.name', 'Phi Test'], { cwd: root })
    await execFileAsync('git', ['config', 'user.email', 'phi@example.invalid'], { cwd: root })
    await writeFile(filter, `#!/bin/sh\ntouch '${sentinel}'\ncat\n`, 'utf8')
    await chmod(filter, 0o755)
    await writeFile(join(root, '.gitattributes'), '*.txt filter=owned\n', 'utf8')
    await writeFile(join(root, 'note.txt'), 'before\n', 'utf8')
    await execFileAsync('git', ['config', 'filter.owned.clean', filter], { cwd: root })
    await execFileAsync('git', ['config', 'filter.owned.required', 'true'], { cwd: root })
    await execFileAsync('git', ['add', '.gitattributes', 'note.txt'], { cwd: root })
    await execFileAsync('git', ['commit', '-m', 'fixture'], { cwd: root })
    await rm(sentinel, { force: true })
    await writeFile(join(root, 'note.txt'), 'bEfore\n', 'utf8')
    const canonicalRoot = await realpath(root)

    const result = await new WorkspaceGitService(
      new LocalHost(canonicalRoot),
      canonicalRoot
    ).summary()

    assert.equal(result.state, 'available')
    if (result.state === 'available') assert.equal(result.dirty, true)
    await assert.rejects(access(sentinel))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('summary ignores global config, aliases, pagers, credential helpers, and injected config', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phi-git-global-config-'))
  const sentinel = join(root, 'external-command-ran')
  const external = join(root, 'external.sh')
  const globalConfig = join(root, 'global.gitconfig')
  const previous = {
    GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
    GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT,
    GIT_CONFIG_KEY_0: process.env.GIT_CONFIG_KEY_0,
    GIT_CONFIG_VALUE_0: process.env.GIT_CONFIG_VALUE_0,
    GIT_PAGER: process.env.GIT_PAGER
  }
  try {
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: root })
    await writeFile(external, `#!/bin/sh\ntouch '${sentinel}'\n`, 'utf8')
    await chmod(external, 0o755)
    await writeFile(
      globalConfig,
      [
        '[core]',
        `  fsmonitor = ${external}`,
        `  pager = ${external}`,
        '[alias]',
        `  status = !${external}`,
        '[pager]',
        `  status = ${external}`,
        '[credential]',
        `  helper = !${external}`,
        ''
      ].join('\n'),
      'utf8'
    )
    process.env.GIT_CONFIG_GLOBAL = globalConfig
    process.env.GIT_CONFIG_COUNT = '1'
    process.env.GIT_CONFIG_KEY_0 = 'core.fsmonitor'
    process.env.GIT_CONFIG_VALUE_0 = external
    process.env.GIT_PAGER = external
    const canonicalRoot = await realpath(root)

    const result = await new WorkspaceGitService(
      new LocalHost(canonicalRoot),
      canonicalRoot
    ).summary()

    assert.equal(result.state, 'available')
    await assert.rejects(access(sentinel))
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    await rm(root, { recursive: true, force: true })
  }
})

test('summary ignores implicit XDG excludes when deciding whether a project is dirty', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phi-git-xdg-project-'))
  const xdg = await mkdtemp(join(tmpdir(), 'phi-git-xdg-config-'))
  const previousXdg = process.env.XDG_CONFIG_HOME
  try {
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: root })
    await mkdir(join(xdg, 'git'), { recursive: true })
    await writeFile(join(xdg, 'git', 'ignore'), '*.secret\n', 'utf8')
    await writeFile(join(root, 'hidden.secret'), 'must remain visible\n', 'utf8')
    process.env.XDG_CONFIG_HOME = xdg
    const canonicalRoot = await realpath(root)

    const result = await new WorkspaceGitService(
      new LocalHost(canonicalRoot),
      canonicalRoot
    ).summary()

    assert.equal(result.state, 'available')
    if (result.state === 'available') assert.equal(result.dirty, true)
  } finally {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previousXdg
    await rm(root, { recursive: true, force: true })
    await rm(xdg, { recursive: true, force: true })
  }
})

test('summary fails closed when repository filter configuration exceeds its bound', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phi-git-config-limit-'))
  try {
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: root })
    const configPath = join(root, '.git', 'config')
    const initialConfig = await readFile(configPath, 'utf8')
    const filters = Array.from(
      { length: 257 },
      (_, index) => `[filter "bounded-${index}"]\n  clean = cat\n`
    ).join('')
    await writeFile(configPath, `${initialConfig}${filters}`, 'utf8')
    const canonicalRoot = await realpath(root)

    const result = await new WorkspaceGitService(
      new LocalHost(canonicalRoot),
      canonicalRoot
    ).summary()

    assert.deepEqual(result, {
      state: 'unavailable',
      reason: 'unsafe-configuration',
      message: 'Git 配置超过安全检查上限；Phi 未执行状态读取。'
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
