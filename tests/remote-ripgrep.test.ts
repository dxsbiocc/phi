import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'

import {
  ensureRemoteRipgrep,
  getRemoteRipgrepStatus,
  REMOTE_RIPGREP_COMPLETE_MARKER
} from '../src/main/agent/workspace-host/remote-ripgrep'
import type { RemoteExecBoundedResult } from '../src/main/agent/wrappers/remote-ssh-session'
import type { RemoteRipgrepResult } from '../src/shared/remoteRipgrepTypes'
import type { RemoteRuntimeRootCheckResult } from '../src/shared/remoteRuntimeRootTypes'
import {
  createRemoteRuntimeFixture,
  installFakeMicromamba,
  type RemoteRuntimeFixture
} from './helpers/remoteRuntimeFixture'
import type { LocalShellSession } from './helpers/localShellSession'

const fixtures: RemoteRuntimeFixture[] = []

function fixture(): RemoteRuntimeFixture {
  const value = createRemoteRuntimeFixture()
  fixtures.push(value)
  return value
}

function boundedResult(code: number): RemoteExecBoundedResult {
  return {
    stdout: '',
    stderr: '',
    code,
    signal: null,
    stdoutTruncated: false,
    stderrTruncated: false
  }
}

function hideSystemRipgrep(session: LocalShellSession): void {
  const execute = session.execBounded?.bind(session)
  assert.ok(execute)
  session.execBounded = async (command, options) => {
    if (command.startsWith('phi_rg=$(command -v rg')) {
      session.commands.push(command)
      return boundedResult(3)
    }
    return execute(command, options)
  }
}

function checkedRoot(root: string): RemoteRuntimeRootCheckResult {
  return {
    configured: root,
    checkedAt: '2026-10-10T00:00:00.000Z',
    status: 'checked',
    expandedPath: root,
    exists: true,
    nearestExistingAncestor: root,
    ancestorWritable: true,
    ownedByCurrentUser: true,
    groupOrOtherWritable: false,
    hasSymlink: false,
    fsType: 'ext4',
    availableKiB: 20_000_000,
    diskUsePercent: 20,
    inodeUsePercent: 10,
    executable: true,
    sharedFilesystem: false,
    computeNodeVisibility: 'unknown',
    hardErrors: [],
    warnings: []
  }
}

async function installManaged(
  remote: RemoteRuntimeFixture,
  session: LocalShellSession,
  forceManaged = false,
  randomId = 'fixture'
): Promise<RemoteRipgrepResult> {
  return ensureRemoteRipgrep(session, {
    runtimeRoot: remote.runtimeRoot,
    confirmedWarnings: [],
    forceManaged,
    checkRuntimeRoot: async () => checkedRoot(remote.runtimeRoot),
    randomId: () => randomId
  })
}

function writeManagedRipgrep(root: string, version: string): string {
  const prefix = join(root, 'tools', `ripgrep-${version}`)
  const executable = join(prefix, 'bin', 'rg')
  mkdirSync(join(prefix, 'bin'), { recursive: true })
  writeFileSync(executable, `#!/bin/sh\nprintf 'ripgrep ${version}\\n'\n`)
  chmodSync(executable, 0o755)
  writeFileSync(join(prefix, REMOTE_RIPGREP_COMPLETE_MARKER), `${version}\n`)
  return executable
}

afterEach(() => {
  for (const remote of fixtures.splice(0)) remote.cleanup()
})

test('installs ripgrep with micromamba into an atomically activated managed prefix', async () => {
  const remote = fixture()
  installFakeMicromamba(remote, '2.9.0-0')
  const session = await remote.connect()
  hideSystemRipgrep(session)

  const result = await installManaged(remote, session)

  assert.equal(result.status, 'installed')
  assert.equal(result.version, '14.1.1')
  assert.equal(result.executablePath, join(remote.runtimeRoot, 'tools/ripgrep-14.1.1/bin/rg'))
  assert.equal(
    readFileSync(
      join(remote.runtimeRoot, 'tools/ripgrep-14.1.1', REMOTE_RIPGREP_COMPLETE_MARKER),
      'utf8'
    ),
    '14.1.1\n'
  )
  assert.equal(statSync(join(remote.runtimeRoot, 'tools')).mode & 0o777, 0o700)
  assert.match(readFileSync(join(remote.runtimeRoot, 'micromamba-calls.log'), 'utf8'), /create -p/)
  assert.ok(
    session.commands.some(
      (command) =>
        command.includes('/micromamba') &&
        command.includes('create -p') &&
        command.includes('--override-channels -c conda-forge --yes ripgrep') &&
        command.includes(`MAMBA_ROOT_PREFIX='${remote.runtimeRoot}'`)
    )
  )
})

test('reuses a valid managed install without invoking micromamba again', async () => {
  const remote = fixture()
  installFakeMicromamba(remote)
  const firstSession = await remote.connect()
  hideSystemRipgrep(firstSession)
  assert.equal((await installManaged(remote, firstSession)).status, 'installed')
  const callsBefore = readFileSync(join(remote.runtimeRoot, 'micromamba-calls.log'), 'utf8')
  const secondSession = await remote.connect()
  hideSystemRipgrep(secondSession)

  const result = await installManaged(remote, secondSession)

  assert.equal(result.status, 'already-installed')
  assert.equal(readFileSync(join(remote.runtimeRoot, 'micromamba-calls.log'), 'utf8'), callsBefore)
})

test('concurrent installers reuse the winner without nesting a temporary prefix', async () => {
  const remote = fixture()
  installFakeMicromamba(remote)
  const firstSession = await remote.connect()
  const secondSession = await remote.connect()
  hideSystemRipgrep(firstSession)
  hideSystemRipgrep(secondSession)

  const results = await Promise.all([
    installManaged(remote, firstSession, false, 'first'),
    installManaged(remote, secondSession, false, 'second')
  ])

  assert(results.every((result) => ['installed', 'already-installed'].includes(result.status)))
  const prefix = join(remote.runtimeRoot, 'tools', 'ripgrep-14.1.1')
  assert.equal(
    readdirSync(prefix).some((name) => name.startsWith('.ripgrep-install-')),
    false
  )
})

test('prefers a usable system rg and only installs managed ripgrep when forced', async () => {
  const remote = fixture()
  installFakeMicromamba(remote)
  const systemSession = await remote.connect()

  const status = await getRemoteRipgrepStatus(systemSession, remote.runtimeRoot)
  const unchanged = await installManaged(remote, systemSession)

  assert.equal(status.status, 'system')
  assert.equal(unchanged.status, 'system')
  assert.equal(statSync(join(remote.runtimeRoot, 'bin')).isDirectory(), true)
  const forcedSession = await remote.connect()
  const forced = await installManaged(remote, forcedSession, true)
  assert.equal(forced.status, 'installed')
})

test('cancellation at the end of system discovery cannot return a successful status', async () => {
  const remote = fixture()
  const session = await remote.connect()
  const execute = session.execBounded?.bind(session)
  assert.ok(execute)
  const controller = new AbortController()
  session.execBounded = async (command, options) => {
    const result = await execute(command, { ...options, signal: undefined })
    if (command.startsWith('phi_rg=$(command -v rg')) controller.abort()
    return result
  }

  const result = await ensureRemoteRipgrep(session, {
    runtimeRoot: remote.runtimeRoot,
    confirmedWarnings: [],
    signal: controller.signal
  })

  assert.equal(result.status, 'failed')
  assert.equal(result.errorCode, 'aborted')
})

test('cancellation during runtime-root checks wins over warning confirmation', async () => {
  const remote = fixture()
  const session = await remote.connect()
  hideSystemRipgrep(session)
  const controller = new AbortController()

  const result = await ensureRemoteRipgrep(session, {
    runtimeRoot: remote.runtimeRoot,
    confirmedWarnings: [],
    signal: controller.signal,
    checkRuntimeRoot: async () => {
      controller.abort()
      return {
        ...checkedRoot(remote.runtimeRoot),
        warnings: [
          {
            code: 'noexec',
            message: '不可执行',
            consequence: '安装后无法运行'
          }
        ]
      }
    }
  })

  assert.equal(result.status, 'failed')
  assert.equal(result.errorCode, 'aborted')
})

test('reports a settings action when micromamba is missing', async () => {
  const remote = fixture()
  const session = await remote.connect()
  hideSystemRipgrep(session)

  const result = await installManaged(remote, session)

  assert.equal(result.status, 'failed')
  assert.equal(result.errorCode, 'micromamba-not-installed')
  assert.match(result.message, /设置 → 远程主机.*安装 micromamba/u)
})

test('distinguishes an unreachable conda source from other installation failures', async () => {
  const remote = fixture()
  installFakeMicromamba(remote, 'offline', 'offline')
  const session = await remote.connect()
  hideSystemRipgrep(session)

  const result = await installManaged(remote, session)

  assert.equal(result.status, 'failed')
  assert.equal(result.errorCode, 'source-unreachable')
  assert.match(result.message, /配置可用镜像.*可联网机器预构建/u)
})

test('selects the newest valid managed marker and ignores incomplete prefixes', async () => {
  const remote = fixture()
  const older = writeManagedRipgrep(remote.runtimeRoot, '13.0.0')
  const newer = writeManagedRipgrep(remote.runtimeRoot, '14.1.1')
  const incomplete = join(remote.runtimeRoot, 'tools', 'ripgrep-99.0.0', 'bin')
  mkdirSync(incomplete, { recursive: true })
  writeFileSync(join(incomplete, 'rg'), '#!/bin/sh\nprintf "ripgrep 99.0.0\\n"\n')
  chmodSync(join(incomplete, 'rg'), 0o755)
  const session = await remote.connect()
  hideSystemRipgrep(session)

  const status = await getRemoteRipgrepStatus(session, remote.runtimeRoot)

  assert.equal(status.status, 'managed')
  assert.equal(status.executablePath, newer)
  assert.notEqual(status.executablePath, older)
})

test('quotes runtime paths containing spaces, quotes, and command syntax', async () => {
  const remote = fixture()
  const specialRoot = join(remote.root, "runtime ' $(touch INJECTED) space")
  mkdirSync(specialRoot)
  remote.runtimeRoot = specialRoot
  installFakeMicromamba(remote)
  const session = await remote.connect()
  hideSystemRipgrep(session)

  const result = await installManaged(remote, session)

  assert.equal(result.status, 'installed')
  assert.equal(result.executablePath, join(specialRoot, 'tools/ripgrep-14.1.1/bin/rg'))
  assert.equal(statSync(join(remote.root, 'INJECTED'), { throwIfNoEntry: false }), undefined)
  assert.ok(session.commands.some((command) => command.includes("'\\''")))
})

test('rejects an invalid runtime root before reading managed tool directories', async () => {
  const remote = fixture()
  const session = await remote.connect()
  hideSystemRipgrep(session)

  const result = await ensureRemoteRipgrep(session, {
    runtimeRoot: `${remote.runtimeRoot}/../outside`,
    confirmedWarnings: []
  })

  assert.equal(result.status, 'failed')
  assert.equal(result.errorCode, 'runtime-root-check-failed')
  assert.equal(session.commands.length, 0)
})
