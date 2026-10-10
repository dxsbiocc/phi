import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { Project } from '../src/main/agent/projects'
import { ensureRemoteProjectAnchor } from '../src/main/agent/remote-project-anchor'
import type { PhiSessionManifest } from '../src/main/agent/session/session-store'
import { remoteGlob, remoteGrep } from '../src/main/agent/remote-workspace-search'
import {
  buildRemoteWorkspaceGlobTool,
  buildRemoteWorkspaceGrepTool,
  PHI_REMOTE_GLOB_DESCRIPTION,
  PHI_REMOTE_GREP_DESCRIPTION
} from '../src/main/agent/remote-workspace-search-tools'
import type { RemoteWorkspaceBoundaryDependencies } from '../src/main/agent/remote-workspace-boundary'
import type { RemoteSshSession } from '../src/main/agent/wrappers/remote-ssh-session'
import { REMOTE_RIPGREP_COMPLETE_MARKER } from '../src/shared/remoteRipgrepTypes'

function fixture(noRg = false): {
  root: string
  runtimeRoot: string
  agentDir: string
  commands: string[]
  dependencies: RemoteWorkspaceBoundaryDependencies
  cleanup: () => void
} {
  const base = mkdtempSync(join(tmpdir(), 'phi-remote-search-'))
  const root = join(base, 'project')
  const runtimeRoot = join(base, "runtime root [managed] 'quoted'")
  const agentDir = join(base, 'phi')
  mkdirSync(root)
  mkdirSync(runtimeRoot)
  const commands: string[] = []
  const location = {
    kind: 'ssh' as const,
    hostProfileId: 'host-a',
    remoteRoot: root,
    canonicalRoot: realpathSync(root)
  }
  const project = {
    id: 'project-a',
    name: 'Project',
    location,
    workingDirectory: root,
    workingDirectoryRealPath: location.canonicalRoot,
    permissionMode: 'ask',
    pathAvailable: true,
    createdAt: '2026-09-24T00:00:00.000Z',
    defaultRemoteConnectionId: 'runtime-host-a',
    remoteConnections: [
      {
        id: 'runtime-host-a',
        label: 'Cluster',
        hostProfileId: 'host-a',
        runtimeRoot
      }
    ]
  } as Project
  const manifest = {
    sessionId: 'session-a',
    kind: 'project',
    projectId: project.id,
    projectLocation: location,
    cwd: ensureRemoteProjectAnchor(project.id, agentDir)
  } as PhiSessionManifest
  const run = (command: string): ReturnType<typeof spawnSync> =>
    spawnSync('bash', ['-c', command], {
      encoding: 'utf-8',
      timeout: 5_000,
      maxBuffer: 2 * 1024 * 1024
    })
  const dependencies: RemoteWorkspaceBoundaryDependencies = {
    agentDir,
    getManifest: (id) => (id === manifest.sessionId ? manifest : null),
    getProject: (id) => (id === project.id ? project : undefined),
    getHostProfile: (id) =>
      id === 'host-a' ? { id, label: 'Cluster', hostAlias: 'cluster-a' } : undefined,
    connectImpl: async (): Promise<RemoteSshSession> => ({
      exec: async (command) => {
        commands.push(command)
        if (noRg && command.includes('command -v rg')) {
          return { stdout: '', stderr: '', code: 1, signal: null }
        }
        const result = run(command)
        return {
          stdout: result.stdout ?? '',
          stderr: result.stderr ?? '',
          code: result.status,
          signal: result.signal
        }
      },
      execBounded: async (command, options) => {
        commands.push(command)
        if (noRg && command.includes('command -v rg')) {
          return {
            stdout: '',
            stderr: '',
            code: 3,
            signal: null,
            stdoutTruncated: false,
            stderrTruncated: false
          }
        }
        const result = run(command)
        const stdout = Buffer.from(result.stdout ?? '')
        const stderr = Buffer.from(result.stderr ?? '')
        const keptStdout = stdout.subarray(0, options.maxOutputBytes)
        const keptStderr = stderr.subarray(
          0,
          Math.max(0, options.maxOutputBytes - keptStdout.byteLength)
        )
        return {
          stdout: keptStdout.toString('utf-8'),
          stderr: keptStderr.toString('utf-8'),
          code: result.status,
          signal: result.signal,
          stdoutTruncated: keptStdout.length < stdout.length,
          stderrTruncated: keptStderr.length < stderr.length
        }
      },
      readTextFile: async () => {
        throw new Error('unbounded read must not be used')
      },
      writeTextFile: async () => {
        throw new Error('search must not write')
      },
      mkdirp: async () => {
        throw new Error('search must not write')
      },
      exists: async () => false,
      uploadFile: async () => {
        throw new Error('search must not upload')
      },
      close: async () => undefined
    })
  }
  return {
    root,
    runtimeRoot,
    agentDir,
    commands,
    dependencies,
    cleanup: () => rmSync(base, { recursive: true, force: true })
  }
}

function installManagedRipgrep(
  sample: ReturnType<typeof fixture>,
  requestedVersion?: string
): string {
  const resolved = spawnSync('bash', ['-lc', 'command -v rg'], { encoding: 'utf-8' })
  assert.equal(resolved.status, 0)
  const systemRg = resolved.stdout.trim()
  const versionOutput = spawnSync(systemRg, ['--version'], { encoding: 'utf-8' })
  const version = requestedVersion ?? versionOutput.stdout.match(/^ripgrep\s+(\S+)/)?.[1]
  assert.ok(version)
  const prefix = join(sample.runtimeRoot, 'tools', `ripgrep-${version}`)
  const binary = join(prefix, 'bin', 'rg')
  mkdirSync(join(prefix, 'bin'), { recursive: true })
  writeFileSync(binary, `#!/bin/sh\nexec ${JSON.stringify(systemRg)} "$@"\n`)
  writeFileSync(join(prefix, REMOTE_RIPGREP_COMPLETE_MARKER), `${version}\n`)
  chmodSync(binary, 0o755)
  return binary
}

const identity = { sessionId: 'session-a', projectId: 'project-a' }

test('ordinary glob and grep find server files through rg', async () => {
  const sample = fixture()
  try {
    mkdirSync(join(sample.root, 'src'))
    mkdirSync(join(sample.root, 'src', 'nested'))
    writeFileSync(join(sample.root, 'src', 'one.ts'), 'const MAGIC = 1\n')
    writeFileSync(join(sample.root, 'src', 'nested', 'two.ts'), 'MAGIC again\n')
    writeFileSync(join(sample.root, 'src', 'other.md'), 'MAGIC docs\n')
    const glob = await remoteGlob({ ...identity, path: 'src/**/*.ts' }, sample.dependencies)
    assert.equal(glob.engine, 'rg')
    assert.equal(glob.truncated, false)
    assert.equal(glob.paths.length, 2)
    assert(glob.paths.every((path) => path.startsWith('ssh://cluster-a')))
    const directories = await remoteGlob(
      { ...identity, path: 'src/**/nested' },
      sample.dependencies
    )
    assert.equal(directories.paths.length, 1)
    assert.match(directories.paths[0], /\/nested\/$/)
    const grep = await remoteGrep(
      { ...identity, pattern: 'MAGIC', path: 'src' },
      sample.dependencies
    )
    assert.equal(grep.engine, 'rg')
    assert.equal(grep.matchCount, 3)
    assert.match(grep.content, /one\.ts:1:const MAGIC/)
    assert.match(grep.content, /two\.ts:1:MAGIC again/)
  } finally {
    sample.cleanup()
  }
})

test('no-rg fallback uses bounded find and grep without following outside symlinks', async () => {
  const sample = fixture(true)
  try {
    mkdirSync(join(sample.root, 'src'))
    writeFileSync(join(sample.root, 'src', 'one.ts'), 'MAGIC\n')
    writeFileSync(join(sample.root, 'src', 'line\nname.ts'), 'MAGIC second\n')
    const outside = join(sample.agentDir, 'outside.ts')
    writeFileSync(outside, 'MAGIC outside\n')
    symlinkSync(outside, join(sample.root, 'src', 'outside.ts'))
    const glob = await remoteGlob({ ...identity, path: 'src/**/*.ts' }, sample.dependencies)
    assert.equal(glob.engine, 'find')
    assert.match(glob.content, /gitignore not applied/)
    assert.match(glob.content, /设置 → 远程主机.*ripgrep.*micromamba/)
    assert.equal(glob.paths.length, 2)
    assert(glob.paths.some((path) => /one\.ts/.test(path)))
    assert(glob.paths.some((path) => /line%0Aname\.ts/.test(path)))
    const grep = await remoteGrep(
      { ...identity, pattern: 'MAGIC', path: 'src' },
      sample.dependencies
    )
    assert.equal(grep.engine, 'find')
    assert.equal(grep.matchCount, 2)
    assert.match(grep.content, /gitignore not applied/)
    assert.match(grep.content, /设置 → 远程主机.*ripgrep.*micromamba/)
    await assert.rejects(
      remoteGrep({ ...identity, pattern: '[', path: 'src' }, sample.dependencies),
      /正则表达式无效/
    )
    await assert.rejects(
      remoteGlob({ ...identity, path: 'src/*.{ts,md}' }, sample.dependencies),
      /仅支持 \*、\*\* 和 \?/
    )
  } finally {
    sample.cleanup()
  }
})

test('managed ripgrep is quoted and used by remote glob and grep when PATH has no rg', async () => {
  const sample = fixture(true)
  try {
    const binary = installManagedRipgrep(sample)
    mkdirSync(join(sample.root, 'src'))
    writeFileSync(join(sample.root, 'src', 'managed.ts'), 'MANAGED_SEARCH\n')

    const glob = await remoteGlob({ ...identity, path: 'src/**/*.ts' }, sample.dependencies)
    const grep = await remoteGrep(
      { ...identity, pattern: 'MANAGED_SEARCH', path: 'src' },
      sample.dependencies
    )

    assert.equal(glob.engine, 'rg-managed', sample.commands.join('\n---\n'))
    assert.equal(grep.engine, 'rg-managed')
    assert.equal(grep.matchCount, 1)
    const managedSuffix = binary.slice(binary.indexOf('/tools/'))
    assert(sample.commands.some((command) => command.includes(managedSuffix)))
  } finally {
    sample.cleanup()
  }
})

test('system PATH ripgrep wins over a valid managed installation', async () => {
  const sample = fixture()
  try {
    installManagedRipgrep(sample)
    writeFileSync(join(sample.root, 'priority.txt'), 'SYSTEM_FIRST\n')
    const result = await remoteGrep({ ...identity, pattern: 'SYSTEM_FIRST' }, sample.dependencies)
    assert.equal(result.engine, 'rg')
  } finally {
    sample.cleanup()
  }
})

test('grep accepts semicolon-delimited project paths without crossing project identity', async () => {
  const sample = fixture()
  try {
    mkdirSync(join(sample.root, 'src'))
    mkdirSync(join(sample.root, 'tests'))
    writeFileSync(join(sample.root, 'src', 'one.ts'), 'MARK\n')
    writeFileSync(join(sample.root, 'tests', 'two.ts'), 'MARK\n')
    const result = await remoteGrep(
      { ...identity, pattern: 'MARK', path: 'src; tests' },
      sample.dependencies
    )
    assert.equal(result.matchCount, 2)
    assert.equal(result.fileCount, 2)
    assert.match(result.content, /one\.ts/)
    assert.match(result.content, /two\.ts/)
  } finally {
    sample.cleanup()
  }
})

test('single-file grep reuses safe bounded read and does not search same-name siblings', async () => {
  const sample = fixture()
  try {
    mkdirSync(join(sample.root, 'nested'))
    writeFileSync(join(sample.root, 'one.txt'), 'MAGIC\n')
    writeFileSync(join(sample.root, 'nested', 'one.txt'), 'MAGIC nested\n')
    const result = await remoteGrep(
      { ...identity, pattern: 'MAGIC', path: 'one.txt' },
      sample.dependencies
    )
    assert.equal(result.engine, 'bounded-text')
    assert.equal(result.matchCount, 1)
    assert.doesNotMatch(result.content, /nested/)
  } finally {
    sample.cleanup()
  }
})

test('search refuses wrong project, root escape, malformed regex and reports result limits', async () => {
  const sample = fixture()
  try {
    for (let index = 0; index < 205; index += 1) {
      writeFileSync(join(sample.root, `item-${index}.txt`), 'needle\n')
    }
    await assert.rejects(
      remoteGlob({ ...identity, projectId: 'other', path: '*.txt' }, sample.dependencies),
      /不匹配/
    )
    await assert.rejects(
      remoteGrep({ ...identity, pattern: 'needle', path: '../outside' }, sample.dependencies),
      /父目录跳转|路径无效/
    )
    await assert.rejects(
      remoteGrep({ ...identity, pattern: '[', path: '.' }, sample.dependencies),
      /正则表达式/
    )
    const glob = await remoteGlob({ ...identity, path: '*.txt' }, sample.dependencies)
    assert.equal(glob.paths.length, 200)
    assert.equal(glob.truncated, true)
  } finally {
    sample.cleanup()
  }
})

test('empty results, hidden files, case-insensitive grep and skip pagination are explicit', async () => {
  const sample = fixture()
  try {
    writeFileSync(join(sample.root, '.hidden.ts'), 'MiXeD\n')
    const empty = await remoteGrep({ ...identity, pattern: 'absent' }, sample.dependencies)
    assert.equal(empty.matchCount, 0)
    assert.equal(empty.truncated, false)
    const ordinary = await remoteGlob({ ...identity, path: '*.ts' }, sample.dependencies)
    assert.equal(ordinary.paths.length, 0)
    const hidden = await remoteGlob(
      { ...identity, path: '*.ts', hidden: true },
      sample.dependencies
    )
    assert.equal(hidden.paths.length, 1)
    const direct = await remoteGrep(
      { ...identity, pattern: 'mixed', path: '.hidden.ts', case: false },
      sample.dependencies
    )
    assert.equal(direct.matchCount, 1)
    for (let index = 0; index < 25; index += 1) {
      writeFileSync(join(sample.root, `page-${index}.txt`), 'PAGINATE\n')
    }
    const first = await remoteGrep({ ...identity, pattern: 'PAGINATE' }, sample.dependencies)
    const next = await remoteGrep(
      { ...identity, pattern: 'PAGINATE', skip: 20 },
      sample.dependencies
    )
    assert.equal(first.fileCount, 20)
    assert.equal(first.truncated, true)
    assert.equal(next.fileCount, 5)
  } finally {
    sample.cleanup()
  }
})

test('permission errors and a directory swapped outside root never return local matches', async () => {
  const sample = fixture()
  try {
    mkdirSync(join(sample.root, 'scope'))
    writeFileSync(join(sample.root, 'scope', 'a.txt'), 'MARK\n')
    const connect = sample.dependencies.connectImpl
    assert.ok(connect)
    await assert.rejects(
      remoteGlob(
        { ...identity, path: 'scope/*.txt' },
        {
          ...sample.dependencies,
          connectImpl: async (config) => {
            const session = await connect(config)
            return {
              ...session,
              execBounded: async () => ({
                stdout: '',
                stderr: 'permission denied',
                code: 2,
                signal: null,
                stdoutTruncated: false,
                stderrTruncated: false
              })
            }
          }
        }
      ),
      /搜索失败/
    )
    const outside = join(sample.agentDir, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'secret.txt'), 'MARK outside\n')
    let swapped = false
    await assert.rejects(
      remoteGrep(
        { ...identity, pattern: 'MARK', path: 'scope' },
        {
          ...sample.dependencies,
          connectImpl: async (config) => {
            const session = await connect(config)
            return {
              ...session,
              exec: async (command) => {
                const result = await session.exec(command)
                if (!swapped) {
                  rmSync(join(sample.root, 'scope'), { recursive: true })
                  symlinkSync(outside, join(sample.root, 'scope'))
                  swapped = true
                }
                return result
              }
            }
          }
        }
      ),
      /搜索失败|项目根目录/
    )
    assert.equal(swapped, true)
  } finally {
    sample.cleanup()
  }
})

test('a truncated fallback scan with no early match never claims a complete empty result', async () => {
  const sample = fixture(true)
  try {
    const connect = sample.dependencies.connectImpl
    assert.ok(connect)
    const result = await remoteGlob(
      { ...identity, path: '*.ts' },
      {
        ...sample.dependencies,
        connectImpl: async (config) => {
          const session = await connect(config)
          return {
            ...session,
            execBounded: async () => ({
              stdout: './none.md\0partial',
              stderr: '',
              code: 0,
              signal: null,
              stdoutTruncated: true,
              stderrTruncated: false
            })
          }
        }
      }
    )
    assert.deepEqual(result.paths, [])
    assert.equal(result.truncated, true)
    assert.match(result.content, /inspected prefix/)
    assert.match(result.content, /results truncated/)
  } finally {
    sample.cleanup()
  }
})

test('same-name glob and grep tools keep OMP parameter names and remote result metadata', async () => {
  const glob = buildRemoteWorkspaceGlobTool(async (input) => ({
    paths: ['ssh://cluster-a/project/a.ts'],
    content: `glob:${input.path}`,
    truncated: false,
    engine: 'rg',
    gitignoreApplied: true
  }))
  assert.equal(glob.name, 'glob')
  assert.equal(glob.description, PHI_REMOTE_GLOB_DESCRIPTION)
  const found = await glob.execute('glob-1', { path: '**/*.ts' }, undefined, {} as never)
  assert.equal(found.content[0]?.text, 'glob:**/*.ts')
  assert.equal((found.details as { fileCount: number }).fileCount, 1)

  const grep = buildRemoteWorkspaceGrepTool(async (input) => ({
    matches: [{ path: 'ssh://cluster-a/project/a.ts', line: 1, text: 'MAGIC' }],
    content: `grep:${input.pattern}`,
    fileCount: 1,
    matchCount: 1,
    truncated: false,
    engine: 'rg',
    gitignoreApplied: true
  }))
  assert.equal(grep.name, 'grep')
  assert.equal(grep.description, PHI_REMOTE_GREP_DESCRIPTION)
  assert.deepEqual(grep.parameters.required, ['pattern'])
  const matched = await grep.execute('grep-1', { pattern: 'MAGIC' }, undefined, {} as never)
  assert.equal(matched.content[0]?.text, 'grep:MAGIC')
  assert.equal((matched.details as { matchCount: number }).matchCount, 1)
})
