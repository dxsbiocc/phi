import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { access, chmod, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'

import {
  ensureRemoteMicromamba,
  type EnsureRemoteMicromambaOptions
} from '../src/main/agent/workspace-host/remote-micromamba'
import type {
  RemoteMicromambaArtifact,
  RemoteMicromambaResult
} from '../src/shared/remoteMicromambaTypes'
import type { RemoteRuntimeRootCheckResult } from '../src/shared/remoteRuntimeRootTypes'
import type { RemoteExecResult } from '../src/main/agent/wrappers/remote-ssh-session'
import { createLocalShellSession, type LocalShellSession } from './helpers/localShellSession'

const temporaryDirectories: string[] = []
const CONFIRM_ALL_WARNINGS = [
  'not-owned',
  'group-or-other-writable',
  'symlink',
  'low-space',
  'high-disk-use',
  'noexec',
  'shared-filesystem-info'
] as const

async function temporaryDirectory(label: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), label))
  temporaryDirectories.push(path)
  return path
}

function runWithInput(command: string, input: string, cwd?: string): Promise<RemoteExecResult> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', command], { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
    child.on('close', (code, signal) => resolve({ stdout, stderr, code, signal }))
    child.stdin.end(input)
  })
}

function localSession(cwd?: string): LocalShellSession {
  const session = createLocalShellSession()
  session.execWithInput = (command, input) => {
    session.commands.push(command)
    return runWithInput(command, input, cwd)
  }
  return session
}

interface FakeArtifactOptions {
  reportedVersion?: string
  reportedPlatform?: string
  versionFails?: boolean
  infoFails?: boolean
}

async function fakeArtifact(
  version = '2.9.0-0',
  options: FakeArtifactOptions = {}
): Promise<RemoteMicromambaArtifact> {
  const directory = await temporaryDirectory('phi-remote-micromamba-artifact-')
  const localPath = join(directory, 'micromamba')
  const content = [
    '#!/bin/sh',
    `if [ "$1" = "--version" ]; then ${options.versionFails ? 'exit 9' : `printf '%s\\n' '${options.reportedVersion ?? version.replace(/-\d+$/, '')}'; exit 0`}; fi`,
    `if [ "$1" = "--rc-file" ] && [ "$2" = "/dev/null" ] && [ "$3" = "info" ]; then ${options.infoFails ? 'exit 9' : `printf '%s\\n' 'platform : ${options.reportedPlatform ?? 'linux-64'}'; exit 0`}; fi`,
    'exit 2',
    ''
  ].join('\n')
  await writeFile(localPath, content)
  await chmod(localPath, 0o755)
  return {
    version,
    platform: 'linux-x64',
    localPath,
    sha256: createHash('sha256').update(content).digest('hex'),
    size: Buffer.byteLength(content)
  }
}

function checkedRoot(
  expandedPath: string,
  overrides: Partial<RemoteRuntimeRootCheckResult> = {}
): RemoteRuntimeRootCheckResult {
  return {
    configured: expandedPath,
    checkedAt: '2026-10-10T00:00:00.000Z',
    status: 'checked',
    expandedPath,
    exists: false,
    nearestExistingAncestor: expandedPath,
    ancestorWritable: true,
    ownedByCurrentUser: true,
    groupOrOtherWritable: false,
    hasSymlink: false,
    fsType: 'apfs',
    availableKiB: 20_000_000,
    diskUsePercent: 20,
    inodeUsePercent: 10,
    executable: true,
    sharedFilesystem: false,
    computeNodeVisibility: 'unknown',
    hardErrors: [],
    warnings: [],
    ...overrides
  }
}

async function installWithCheckedRoot(
  session: LocalShellSession,
  root: string,
  artifact: RemoteMicromambaArtifact,
  overrides: Partial<EnsureRemoteMicromambaOptions> = {}
): Promise<RemoteMicromambaResult> {
  return ensureRemoteMicromamba(session, {
    runtimeRoot: root,
    confirmedWarnings: CONFIRM_ALL_WARNINGS,
    artifact,
    checkRuntimeRoot: async () => checkedRoot(root),
    ...overrides
  })
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

test('installs and verifies micromamba in a checked remote runtime root', async () => {
  const parent = await temporaryDirectory('phi-remote-micromamba-root-')
  const runtimeRoot = join(parent, 'runtime')
  const artifact = await fakeArtifact()
  const session = localSession()
  const phases: string[] = []

  try {
    const result = await ensureRemoteMicromamba(session, {
      runtimeRoot,
      confirmedWarnings: CONFIRM_ALL_WARNINGS,
      artifact,
      onProgress: ({ stage }) => phases.push(stage)
    })

    const installedPath = join(await realpath(parent), 'runtime', 'bin', 'micromamba-2.9.0-0')
    assert.equal(result.status, 'installed', JSON.stringify(result))
    assert.equal(result.installPath, installedPath)
    assert.equal(result.verification?.versionMatches, true)
    assert.equal(result.verification?.version, '2.9.0')
    assert.equal(result.verification?.platformMatches, true)
    assert.equal(session.uploads.length, 1)
    assert.equal(await readFile(installedPath, 'utf8'), await readFile(artifact.localPath, 'utf8'))
    assert.equal((await stat(installedPath)).mode & 0o777, 0o755)
    assert.ok(phases.includes('uploading'))
    assert.ok(phases.includes('verifying-installation'))
    assert.ok(session.commands.every((command) => command === 'sh -s'))
  } finally {
    await session.close()
  }
})

test('reuses an intact matching installation without uploading again', async () => {
  const root = join(await temporaryDirectory('phi-remote-micromamba-idempotent-'), 'runtime')
  const artifact = await fakeArtifact()
  const session = localSession()

  try {
    assert.equal((await installWithCheckedRoot(session, root, artifact)).status, 'installed')
    const repeated = await installWithCheckedRoot(session, root, artifact)

    assert.equal(repeated.status, 'already-installed')
    assert.equal(session.uploads.length, 1)
  } finally {
    await session.close()
  }
})

test('keeps previously installed release versions when activating an update', async () => {
  const root = join(await temporaryDirectory('phi-remote-micromamba-versions-'), 'runtime')
  const first = await fakeArtifact('2.9.0-0')
  const second = await fakeArtifact('2.10.0-0')
  const session = localSession()

  try {
    assert.equal((await installWithCheckedRoot(session, root, first)).status, 'installed')
    assert.equal((await installWithCheckedRoot(session, root, second)).status, 'installed')
    await access(join(root, 'bin', 'micromamba-2.9.0-0'))
    await access(join(root, 'bin', 'micromamba-2.10.0-0'))
    assert.equal(session.uploads.length, 2)
  } finally {
    await session.close()
  }
})

test('rejects a remote hash mismatch after one retry and cleans staging files', async () => {
  const root = join(await temporaryDirectory('phi-remote-micromamba-hash-'), 'runtime')
  const artifact = { ...(await fakeArtifact()), sha256: 'f'.repeat(64) }
  const session = localSession()

  try {
    const result = await installWithCheckedRoot(session, root, artifact)

    assert.equal(result.status, 'failed')
    assert.equal(result.errorCode, 'remote-hash-mismatch')
    assert.equal(session.uploads.length, 2)
    for (const { remotePath } of session.uploads) {
      await assert.rejects(access(remotePath))
    }
    await assert.rejects(access(join(root, 'bin', `micromamba-${artifact.version}`)))
  } finally {
    await session.close()
  }
})

test('retries one interrupted upload and succeeds on the second attempt', async () => {
  const root = join(await temporaryDirectory('phi-remote-micromamba-retry-'), 'runtime')
  const artifact = await fakeArtifact()
  const session = localSession()
  const upload = session.uploadFile.bind(session)
  let attempts = 0
  session.uploadFile = async (...args) => {
    attempts += 1
    if (attempts === 1) throw new Error('private upload failure detail')
    await upload(...args)
  }

  try {
    const result = await installWithCheckedRoot(session, root, artifact)

    assert.equal(result.status, 'installed')
    assert.equal(attempts, 2)
    assert.doesNotMatch(result.message, /private upload failure detail/)
  } finally {
    await session.close()
  }
})

test('returns a hard runtime-root error without writing or leaking its path', async () => {
  const root = join(await temporaryDirectory('phi-remote-micromamba-hard-error-'), 'secret')
  const artifact = await fakeArtifact()
  const session = localSession()

  try {
    const result = await installWithCheckedRoot(session, root, artifact, {
      checkRuntimeRoot: async () =>
        checkedRoot(root, {
          hardErrors: [{ code: 'ancestor-not-writable', message: `private path: ${root}` }]
        })
    })

    assert.equal(result.status, 'failed')
    assert.equal(result.errorCode, 'runtime-root-hard-error')
    assert.doesNotMatch(result.message, new RegExp(root))
    assert.equal(session.commands.length, 0)
    assert.equal(session.uploads.length, 0)
    await assert.rejects(access(root))
  } finally {
    await session.close()
  }
})

test('requires confirmation before noexec writes and explains the execution consequence', async () => {
  const root = join(await temporaryDirectory('phi-remote-micromamba-confirm-'), 'runtime')
  const artifact = await fakeArtifact()
  const session = localSession()
  const noexecWarning = {
    code: 'noexec' as const,
    message: '该位置无法执行临时探针脚本。',
    consequence: '受管环境中的可执行文件将无法直接运行。'
  }

  try {
    const result = await installWithCheckedRoot(session, root, artifact, {
      confirmedWarnings: [],
      checkRuntimeRoot: async () =>
        checkedRoot(root, { executable: false, warnings: [noexecWarning] })
    })

    assert.equal(result.status, 'needs-confirmation')
    assert.deepEqual(result.warningCodes, ['noexec'])
    assert.match(result.message, /micromamba 将无法运行/)
    assert.match(result.message, /建议更换可执行位置/)
    assert.equal(session.commands.length, 0)
    assert.equal(session.uploads.length, 0)
    await assert.rejects(access(root))
  } finally {
    await session.close()
  }
})

test('safely installs into a path containing spaces, quotes, and command substitution text', async () => {
  const parent = await temporaryDirectory('phi-remote-micromamba-quoting-')
  const root = join(parent, "runtime ' $(touch PWNED)")
  const artifact = await fakeArtifact()
  const session = localSession(parent)

  try {
    const result = await ensureRemoteMicromamba(session, {
      runtimeRoot: root,
      confirmedWarnings: CONFIRM_ALL_WARNINGS,
      artifact
    })

    assert.equal(result.status, 'installed', JSON.stringify(result))
    await access(join(root, 'bin', `micromamba-${artifact.version}`))
    await assert.rejects(access(join(parent, 'PWNED')))
  } finally {
    await session.close()
  }
})

test('reports a post-install platform verification failure without hiding the installed file', async () => {
  const root = join(await temporaryDirectory('phi-remote-micromamba-verify-'), 'runtime')
  const artifact = await fakeArtifact('2.9.0-0', { reportedPlatform: 'linux-aarch64' })
  const session = localSession()

  try {
    const result = await installWithCheckedRoot(session, root, artifact)

    assert.equal(result.status, 'failed')
    assert.equal(result.errorCode, 'verification-failed')
    assert.equal(result.verification?.runnable, true)
    assert.equal(result.verification?.platformMatches, false)
    await access(join(root, 'bin', `micromamba-${artifact.version}`))
  } finally {
    await session.close()
  }
})

test('continues after confirmed noexec and reports the actual execution failure', async () => {
  const root = join(await temporaryDirectory('phi-remote-micromamba-noexec-'), 'runtime')
  const artifact = await fakeArtifact('2.9.0-0', { versionFails: true })
  const session = localSession()
  const warning = {
    code: 'noexec' as const,
    message: '该位置无法执行临时探针脚本。',
    consequence: '受管环境中的可执行文件将无法直接运行。'
  }

  try {
    const result = await installWithCheckedRoot(session, root, artifact, {
      confirmedWarnings: ['noexec'],
      checkRuntimeRoot: async () => checkedRoot(root, { executable: false, warnings: [warning] })
    })

    assert.equal(result.status, 'failed')
    assert.equal(result.errorCode, 'verification-failed')
    assert.deepEqual(result.warningCodes, ['noexec'])
    assert.equal(result.verification?.runnable, false)
    assert.equal(session.uploads.length, 1)
  } finally {
    await session.close()
  }
})
