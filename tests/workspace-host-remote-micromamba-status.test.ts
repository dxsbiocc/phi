import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'

import { getRemoteMicromambaStatus } from '../src/main/agent/workspace-host/remote-micromamba'
import type { RemoteExecResult } from '../src/main/agent/wrappers/remote-ssh-session'
import { createLocalShellSession, type LocalShellSession } from './helpers/localShellSession'

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'phi-remote-micromamba-status-'))
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

async function writeMicromamba(
  root: string,
  release: string,
  options: { runnable?: boolean; platform?: string } = {}
): Promise<string> {
  const path = join(root, 'bin', `micromamba-${release}`)
  await mkdir(join(root, 'bin'), { recursive: true })
  const binaryVersion = release.replace(/-\d+$/, '')
  const content =
    options.runnable === false
      ? '#!/bin/sh\nexit 9\n'
      : [
          '#!/bin/sh',
          `if [ "$1" = "--version" ]; then echo '${binaryVersion}'; exit 0; fi`,
          `if [ "$1" = "--rc-file" ]; then echo 'platform : ${options.platform ?? 'linux-64'}'; exit 0; fi`,
          'exit 2',
          ''
        ].join('\n')
  await writeFile(path, content)
  await chmod(path, 0o755)
  return path
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

test('reports not installed without creating the configured runtime root', async () => {
  const root = join(await temporaryDirectory(), 'missing-runtime')
  const session = localSession()

  try {
    const result = await getRemoteMicromambaStatus(session, root, {
      expectedVersion: '2.9.0-0',
      platform: 'linux-x64'
    })

    assert.equal(result.status, 'not-installed')
    assert.equal(result.runnable, false)
    assert.deepEqual(result.installedVersions, [])
    await assert.rejects(access(root))
  } finally {
    await session.close()
  }
})

test('reports a matching runnable release without modifying its file', async () => {
  const root = join(await temporaryDirectory(), 'runtime')
  const path = await writeMicromamba(root, '2.9.0-0')
  const before = await readFile(path, 'utf8')
  const session = localSession()

  try {
    const result = await getRemoteMicromambaStatus(session, root, {
      expectedVersion: '2.9.0-0',
      platform: 'linux-x64'
    })

    assert.equal(result.status, 'installed')
    assert.equal(result.versionMatches, true)
    assert.equal(result.runnable, true)
    assert.deepEqual(result.installedVersions, ['2.9.0-0'])
    assert.equal(await readFile(path, 'utf8'), before)
  } finally {
    await session.close()
  }
})

test('reports installed older releases as outdated without executing them', async () => {
  const root = join(await temporaryDirectory(), 'runtime')
  await writeMicromamba(root, '2.8.0-0', { runnable: false })
  const session = localSession()

  try {
    const result = await getRemoteMicromambaStatus(session, root, {
      expectedVersion: '2.9.0-0',
      platform: 'linux-x64'
    })

    assert.equal(result.status, 'outdated')
    assert.equal(result.versionMatches, false)
    assert.equal(result.runnable, null)
    assert.deepEqual(result.installedVersions, ['2.8.0-0'])
  } finally {
    await session.close()
  }
})

test('reports the expected release as unusable when isolated verification fails', async () => {
  const root = join(await temporaryDirectory(), 'runtime')
  await writeMicromamba(root, '2.9.0-0', { runnable: false })
  const session = localSession()

  try {
    const result = await getRemoteMicromambaStatus(session, root, {
      expectedVersion: '2.9.0-0',
      platform: 'linux-x64'
    })

    assert.equal(result.status, 'unusable')
    assert.equal(result.runnable, false)
    assert.equal(result.errorCode, 'verification-failed')
  } finally {
    await session.close()
  }
})

test('checks a special missing path without writes or command substitution', async () => {
  const parent = await temporaryDirectory()
  const root = join(parent, "missing ' $(touch PWNED)")
  const session = localSession(parent)

  try {
    const result = await getRemoteMicromambaStatus(session, root, {
      expectedVersion: '2.9.0-0',
      platform: 'linux-x64'
    })

    assert.equal(result.status, 'not-installed')
    await assert.rejects(access(root))
    await assert.rejects(access(join(parent, 'PWNED')))
  } finally {
    await session.close()
  }
})
