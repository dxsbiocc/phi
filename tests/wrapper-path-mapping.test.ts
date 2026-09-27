import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  isRemoteAbsolutePath,
  isWithinRemoteRoot,
  resolveCompositionInputParams,
  resolveRemoteInputPath,
  validateInputPathMapping
} from '../src/main/agent/wrappers/path-mapping'

const ssh = {
  kind: 'ssh' as const,
  hostProfileId: 'host-a',
  remoteRoot: '/home/me/project-link',
  canonicalRoot: '/data/project'
}
const local = {
  kind: 'local' as const,
  path: '/Users/me/project',
  realPath: '/Users/me/project'
}
const mapping = { localRoot: '/Users/me/project/data', remoteRoot: '/cluster/project/data' }

test('borrowed POSIX path checks reject NUL and sibling-prefix escapes', () => {
  assert.equal(isRemoteAbsolutePath('/data/project'), true)
  assert.equal(isRemoteAbsolutePath('../project'), false)
  assert.equal(isRemoteAbsolutePath('/data/\0bad'), false)
  assert.equal(isWithinRemoteRoot('/data/project', '/data/project/reads/a.fq'), true)
  assert.equal(isWithinRemoteRoot('/data/project', '/data/project-other/a.fq'), false)
  assert.equal(isWithinRemoteRoot('/data/project', '/data'), false)
  assert.deepEqual(validateInputPathMapping(mapping), [])
  assert.match(
    validateInputPathMapping({ localRoot: 'relative', remoteRoot: '/cluster' })[0],
    /本地映射根/
  )
})

test('SSH project resolves relative, absolute and glob inputs only inside its server root', () => {
  const relative = resolveRemoteInputPath('reads', 'reads/*_{R1,R2}.fq.gz', {
    projectLocation: ssh
  })
  assert.deepEqual(relative.resolution?.remotePaths, ['/data/project/reads/*_{R1,R2}.fq.gz'])
  assert.equal(relative.resolution?.kind, 'glob')
  assert.equal(relative.resolution?.source, 'remote')
  const absolute = resolveRemoteInputPath(
    'ref',
    { source: 'remote', path: '/data/project/ref.fa' },
    { projectLocation: ssh }
  )
  assert.deepEqual(absolute.resolution?.remotePaths, ['/data/project/ref.fa'])
  assert.match(
    resolveRemoteInputPath('escape', '../outside.fa', { projectLocation: ssh }).errors[0],
    /超出远程项目目录/
  )
  assert.match(
    resolveRemoteInputPath('sibling', '/data/project-other/a.fq', { projectLocation: ssh })
      .errors[0],
    /超出远程项目目录/
  )
  assert.match(
    resolveRemoteInputPath(
      'local',
      { source: 'local', path: '/Users/me/file' },
      { projectLocation: ssh }
    ).errors[0],
    /不能引用本机/
  )
})

test('local project maps only explicit local references and leaves remote strings remote', () => {
  const context = { projectLocation: local, mapping }
  const mapped = resolveRemoteInputPath(
    'reads',
    { source: 'local', path: 'data/reads/*.fq.gz' },
    context
  )
  assert.deepEqual(mapped.resolution?.localPaths, ['/Users/me/project/data/reads/*.fq.gz'])
  assert.deepEqual(mapped.resolution?.remotePaths, ['/cluster/project/data/reads/*.fq.gz'])
  assert.equal(mapped.resolution?.source, 'local')
  assert.match(
    resolveRemoteInputPath('escape', { source: 'local', path: 'data/../other/a.fq' }, context)
      .errors[0],
    /超出本机映射根/
  )
  assert.match(
    resolveRemoteInputPath(
      'sibling',
      { source: 'local', path: '/Users/me/project/data-other/a.fq' },
      context
    ).errors[0],
    /超出本机映射根/
  )
  assert.deepEqual(
    resolveRemoteInputPath('remote', '/cluster/project/data/reads/a.fq', context).resolution
      ?.remotePaths,
    ['/cluster/project/data/reads/a.fq']
  )
  assert.deepEqual(
    resolveRemoteInputPath('remote-relative', 'reads/a.fq', context).resolution?.remotePaths,
    ['/cluster/project/data/reads/a.fq']
  )
  assert.match(
    resolveRemoteInputPath(
      'unmapped',
      { source: 'local', path: '/Users/me/file' },
      { projectLocation: local }
    ).errors[0],
    /没有配置/
  )
  assert.match(
    resolveRemoteInputPath('unmapped-relative', 'reads/a.fq', { projectLocation: local }).errors[0],
    /服务器绝对路径/
  )
})

test('a same-named local file cannot turn a legacy remote string into a local input', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phi-path-mapping-'))
  try {
    const path = join(dir, 'sample.fq')
    writeFileSync(path, 'local data')
    const result = resolveRemoteInputPath('reads', path, { projectLocation: local, mapping })
    assert.equal(result.resolution?.source, 'remote')
    assert.deepEqual(result.resolution?.localPaths, [])
    assert.deepEqual(result.resolution?.remotePaths, [path])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('remote URLs stay remote and unsupported schemes or malformed refs fail clearly', () => {
  assert.deepEqual(
    resolveRemoteInputPath('url', 'https://example.org/reads.fq', { projectLocation: ssh })
      .resolution?.remotePaths,
    ['https://example.org/reads.fq']
  )
  assert.match(
    resolveRemoteInputPath('ssh-url', 'ssh://other-host/etc/hosts', { projectLocation: ssh })
      .errors[0],
    /URL 类型暂不支持/
  )
  assert.match(
    resolveRemoteInputPath(
      'bad',
      { source: 'local', path: '/a', host: 'other' },
      { projectLocation: local, mapping }
    ).errors[0],
    /必须是路径/
  )
})

test('composition inputs normalize declared paths but leave options unchanged', () => {
  const manifest = {
    id: 'test/module',
    name: 'Test',
    summary: 'Test',
    params: {
      gff: { kind: 'input' as const, type: 'file', required: true },
      threads: { kind: 'option' as const, type: 'integer', required: false }
    },
    outputs: {}
  }
  const remoteResult = resolveCompositionInputParams(
    manifest,
    {
      gff: { source: 'local', path: 'data/genome.gff3' },
      threads: 8
    },
    { remote: true, projectLocation: local, mapping }
  )
  assert.equal(remoteResult.params.gff, '/cluster/project/data/genome.gff3')
  assert.equal(remoteResult.params.threads, 8)
  assert.equal(remoteResult.inputs[0]?.source, 'local')
  const localResult = resolveCompositionInputParams(
    manifest,
    {
      gff: { source: 'local', path: 'data/genome.gff3' },
      threads: 8
    },
    { remote: false, projectLocation: local }
  )
  assert.equal(localResult.params.gff, '/Users/me/project/data/genome.gff3')
  assert.deepEqual(localResult.inputs[0]?.localPaths, ['/Users/me/project/data/genome.gff3'])
})
