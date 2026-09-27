import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  buildRemoteInputProbeCommand,
  checkRemoteWrapperInputs
} from '../src/main/agent/wrappers/remote-input-check'
import { resolveRemoteInputPath } from '../src/main/agent/wrappers/path-mapping'
import type { WrapperInputResolution } from '../src/shared/wrapperTypes'
import { createLocalShellSession } from './helpers/localShellSession'

function input(id: string, path: string, root?: string): WrapperInputResolution {
  return {
    id,
    kind: path.includes('*') ? 'glob' : 'path',
    source: 'remote',
    userValue: path,
    localPaths: [],
    remotePaths: [path],
    ...(root ? { allowedRemoteRoot: root } : {})
  }
}

test('server stat differentiates existing, missing, permission and final symlink escape', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'phi-remote-input-check-'))
  const root = join(parent, 'project')
  const outside = join(parent, 'outside')
  mkdirSync(root)
  mkdirSync(outside)
  const present = join(root, 'reads.fq')
  const denied = join(root, 'denied.fq')
  const escape = join(root, 'escape.fq')
  writeFileSync(present, 'remote data')
  writeFileSync(denied, 'secret')
  chmodSync(denied, 0o000)
  writeFileSync(join(outside, 'reads.fq'), 'outside data')
  symlinkSync(join(outside, 'reads.fq'), escape)
  const session = createLocalShellSession()
  try {
    const result = await checkRemoteWrapperInputs(session, [
      input('present', present, root),
      input('missing', join(root, 'missing.fq'), root),
      input('denied', denied, root),
      input('escape', escape, root)
    ])
    assert.equal(
      result.errors.some((error) => error.includes('present')),
      false
    )
    assert.match(result.errors.join('\n'), /missing.*不存在/)
    assert.match(result.errors.join('\n'), /denied.*无读取或进入权限/)
    assert.match(result.errors.join('\n'), /escape.*符号链接目标超出/)
  } finally {
    chmodSync(denied, 0o600)
    await session.close()
    rmSync(parent, { recursive: true, force: true })
  }
})

test('glob checks only its fixed directory prefix and returns a visible warning', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'phi-remote-glob-check-'))
  const root = join(parent, 'project')
  const reads = join(root, 'reads')
  mkdirSync(root)
  mkdirSync(reads)
  const session = createLocalShellSession()
  try {
    const result = await checkRemoteWrapperInputs(session, [
      input('fastq', `${reads}/*.fq.gz`, root)
    ])
    assert.deepEqual(result.errors, [])
    assert.match(result.warnings.join('\n'), /fastq.*仅核验固定目录前缀/)
    assert.match(result.warnings.join('\n'), /尚未确认匹配文件/)
    const missing = await checkRemoteWrapperInputs(session, [
      input('fastq', `${root}/missing/*.fq.gz`, root)
    ])
    assert.match(missing.errors.join('\n'), /不存在: .*missing/)
  } finally {
    await session.close()
    rmSync(parent, { recursive: true, force: true })
  }
})

test('a local same-name file cannot satisfy a missing server observation', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'phi-local-same-name-'))
  const localFile = join(parent, 'same.fq')
  writeFileSync(localFile, 'local only')
  try {
    const commands: string[] = []
    const fake = {
      exec: async (command: string) => {
        commands.push(command)
        return { stdout: '', stderr: '', code: 41, signal: null }
      }
    } as ReturnType<typeof createLocalShellSession>
    const result = await checkRemoteWrapperInputs(fake, [input('same', localFile)])
    assert.match(result.errors.join('\n'), /same.*不存在/)
    assert.equal(commands.length, 1)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('explicit server paths and C01 mapped paths are checked at their final server locations', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'phi-mapped-input-check-'))
  const localRoot = join(parent, 'local')
  const remoteRoot = join(parent, 'remote')
  mkdirSync(localRoot)
  mkdirSync(remoteRoot)
  writeFileSync(join(remoteRoot, 'reads.fq'), 'server data')
  const projectLocation = { kind: 'local' as const, path: localRoot, realPath: localRoot }
  const mapped = resolveRemoteInputPath(
    'mapped',
    { source: 'local', path: 'reads.fq' },
    { projectLocation, mapping: { localRoot, remoteRoot } }
  ).resolution
  const explicit = resolveRemoteInputPath(
    'explicit',
    { source: 'remote', path: join(remoteRoot, 'reads.fq') },
    { projectLocation }
  ).resolution
  assert.ok(mapped)
  assert.ok(explicit)
  const session = createLocalShellSession()
  try {
    assert.deepEqual(await checkRemoteWrapperInputs(session, [mapped, explicit]), {
      errors: [],
      warnings: []
    })
    assert.equal(mapped.allowedRemoteRoot, remoteRoot)
    assert.equal(mapped.localPaths[0], join(localRoot, 'reads.fq'))
  } finally {
    await session.close()
    rmSync(parent, { recursive: true, force: true })
  }
})

test('the probe quotes special paths and never embeds them as shell syntax', () => {
  const command = buildRemoteInputProbeCommand("/data/a'b; echo wrong", false)
  assert.match(command, /perl -e/)
  assert.doesNotMatch(command, /; echo wrong'\s*$/)
})

test('an input without a final server path fails closed', async () => {
  const session = createLocalShellSession()
  try {
    const result = await checkRemoteWrapperInputs(session, [
      {
        id: 'reads',
        kind: 'path',
        source: 'remote',
        userValue: 'reads.fq',
        localPaths: []
      }
    ])
    assert.match(result.errors.join('\n'), /reads.*缺少最终服务器路径/)
  } finally {
    await session.close()
  }
})
