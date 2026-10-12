import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { analyzeProject } from '../src/main/agent/packages/github-project-hint'

const roots: string[] = []
const repository = { owner: 'xieningqing', name: 'qq-email-mcp', repo: 'xieningqing/qq-email-mcp' }
const sha = 'a'.repeat(40)

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), 'phi-github-project-hint-'))
  roots.push(root)
  return root
}

function writeJson(root: string, value: unknown): void {
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'package.json'), `${JSON.stringify(value)}\n`)
}

test('recognises a Node MCP package whose built bin is not committed', () => {
  const root = sandbox()
  writeJson(root, {
    name: 'qq-email-mcp',
    version: '0.1.1',
    bin: { 'qq-email-mcp': 'dist/index.js' },
    scripts: { build: 'tsc -p tsconfig.json' },
    engines: { node: '>=20.19' }
  })

  assert.deepEqual(analyzeProject(root, repository, sha), {
    kind: 'node',
    summary: 'Node.js 项目 qq-email-mcp 0.1.1',
    name: 'qq-email-mcp',
    version: '0.1.1',
    entry: 'dist/index.js',
    entryCommitted: false,
    needsBuild: true,
    nodeEngine: '>=20.19',
    hasLifecycleScripts: false,
    hasLockfile: false,
    notices: [
      '入口 dist/index.js 未随源码提交，需要先构建；Phi 不会自动构建源码',
      '声明需要 Node >=20.19；Phi 内置 Bun 提供 Node 兼容 API，不保证所有依赖可用'
    ]
  })
})

test('uses string bin and falls back to main when bin is absent', () => {
  const stringBin = sandbox()
  writeJson(stringBin, { name: 'string-bin', version: '1.0.0', bin: 'cli.js' })
  assert.equal(analyzeProject(stringBin, repository, sha).entry, 'cli.js')

  const main = sandbox()
  writeJson(main, { name: 'main-entry', version: '2.0.0', main: 'server.js' })
  assert.equal(analyzeProject(main, repository, sha).entry, 'server.js')
})

test('prefers the package-named bin and checks a committed entry inside the snapshot', () => {
  const root = sandbox()
  writeJson(root, {
    name: 'qq-email-mcp',
    version: '0.1.1',
    bin: { other: 'other.js', 'qq-email-mcp': 'src/index.js' },
    scripts: { build: 'tsc' }
  })
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'index.js'), '')

  const hint = analyzeProject(root, repository, sha)
  assert.equal(hint.entry, 'src/index.js')
  assert.equal(hint.entryCommitted, true)
  assert.equal(hint.needsBuild, false)
})

test('reports lifecycle, lockfile, private-package, and README facts', () => {
  const root = sandbox()
  writeJson(root, {
    name: 'private-server',
    version: '1.2.3',
    private: true,
    scripts: { prepare: 'node prepare.js' }
  })
  writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  writeFileSync(join(root, 'README.md'), '# Private server\n')

  const hint = analyzeProject(root, repository, sha)
  assert.equal(hint.hasLifecycleScripts, true)
  assert.equal(hint.hasLockfile, true)
  assert.equal(hint.readmeUrl, `https://github.com/xieningqing/qq-email-mcp/blob/${sha}/README.md`)
  assert.deepEqual(hint.notices, [
    'npm 安装时可能运行脚本或编译原生模块',
    '该包标记为 private，不会发布到 npm'
  ])
})

test('does not treat entries outside the snapshot or symlinked entries as committed', () => {
  const root = sandbox()
  const outside = sandbox()
  writeFileSync(join(outside, 'server.js'), '')
  writeJson(root, {
    name: 'unsafe-entry',
    version: '1.0.0',
    main: '../server.js',
    scripts: { build: 'tsc' }
  })
  assert.equal(analyzeProject(root, repository, sha).entryCommitted, false)

  writeJson(root, {
    name: 'linked-entry',
    version: '1.0.0',
    main: 'server.js',
    scripts: { build: 'tsc' }
  })
  symlinkSync(join(outside, 'server.js'), join(root, 'server.js'))
  assert.equal(analyzeProject(root, repository, sha).entryCommitted, false)
})

test('recognises conservative project metadata from pyproject.toml', () => {
  const root = sandbox()
  writeFileSync(
    join(root, 'pyproject.toml'),
    '[build-system]\nrequires = ["hatchling"]\n\n[project]\nname = "mail-mcp"\nversion = "0.4.0"\n'
  )

  assert.deepEqual(analyzeProject(root, repository, sha), {
    kind: 'python',
    summary: 'Python 项目 mail-mcp 0.4.0',
    name: 'mail-mcp',
    version: '0.4.0',
    notices: ['Python 项目暂不支持自动安装；可在终端自行安装后，用 本地 (stdio) 添加']
  })
})

test('reports unknown projects when bounded metadata is absent or unusable', () => {
  const notice =
    '这个仓库不是 Phi 软件包格式（没有 phi-package.yaml），也没有识别到 Node 或 Python 项目。'
  const empty = sandbox()
  assert.deepEqual(analyzeProject(empty, repository, sha).notices, [notice])

  const invalid = sandbox()
  writeFileSync(join(invalid, 'package.json'), '{invalid')
  assert.equal(analyzeProject(invalid, repository, sha).kind, 'unknown')

  const oversized = sandbox()
  writeFileSync(join(oversized, 'package.json'), Buffer.alloc(1024 * 1024 + 1, 0x20))
  assert.equal(analyzeProject(oversized, repository, sha).kind, 'unknown')
})

test('ignores a symlinked package.json without following it', () => {
  const root = sandbox()
  const outside = sandbox()
  writeJson(outside, { name: 'outside', version: '1.0.0' })
  symlinkSync(join(outside, 'package.json'), join(root, 'package.json'))

  assert.equal(analyzeProject(root, repository, sha).kind, 'unknown')
})
