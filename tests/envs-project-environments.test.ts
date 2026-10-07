import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { describeEnvironment } from '../src/main/agent/content/environment-refs'
import { currentPlatform, parseEnvironmentSpec, type EnvironmentSpec } from '../src/main/agent/envs'
import {
  applyOverrides,
  nextProjectEnvironmentName,
  projectOwner,
  readOverrides,
  setOverride,
  writeOverrides,
  writeProjectEnvironment
} from '../src/main/agent/envs/project-environments'

const FIXTURE = join(process.cwd(), 'tests/fixtures/envs/minimal')

function temporary(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'phi-project-env-')))
}

function remove(path: string): void {
  rmSync(path, { recursive: true, force: true })
}

function lockText(platform: string): string {
  return readFileSync(join(FIXTURE, 'locks', `${platform}.txt`), 'utf8')
}

function minimalSpec(name: string): EnvironmentSpec {
  const parsed = parseEnvironmentSpec(readFileSync(join(FIXTURE, 'environment.yml'), 'utf8'))
  assert.equal(parsed.ok, true)
  if (!parsed.ok) throw new Error('fixture spec is invalid')
  return { ...parsed.spec, name }
}

test('project owner is p plus 10 hex of the real path', () => {
  const dir = temporary()
  const other = temporary()
  const linkRoot = temporary()
  try {
    const link = join(linkRoot, 'link')
    symlinkSync(dir, link)
    const owner = projectOwner(dir)
    assert.equal(owner, projectOwner(link))
    assert.equal(
      owner,
      `p${createHash('sha256').update(realpathSync(dir)).digest('hex').slice(0, 10)}`
    )
    assert.match(owner, /^p[0-9a-f]{10}$/)
    assert.notEqual(owner, projectOwner(other))
  } finally {
    remove(dir)
    remove(other)
    remove(linkRoot)
  }
})

test('project environment names take the next free -x suffix', () => {
  const dir = temporary()
  try {
    assert.equal(nextProjectEnvironmentName(dir, 'python'), 'python-x1')
    mkdirSync(join(dir, '.phi', 'environments', 'python-x1'), { recursive: true })
    mkdirSync(join(dir, '.phi', 'environments', 'python-x3'))
    mkdirSync(join(dir, '.phi', 'environments', 'demo-x9'))
    writeFileSync(join(dir, '.phi', 'environments', 'python-x8'), 'not a directory')
    assert.equal(nextProjectEnvironmentName(dir, 'python'), 'python-x4')
    assert.equal(nextProjectEnvironmentName(dir, 'demo'), 'demo-x10')
    assert.throws(() => nextProjectEnvironmentName(dir, 'Python'), /project:/)
    assert.throws(() => nextProjectEnvironmentName(dir, ''), /project:/)
  } finally {
    remove(dir)
  }
})

test('overrides are atomic, invalid files are empty, and a missing target is ignored once', () => {
  const dir = temporary()
  const platform = currentPlatform()
  try {
    const missing = readOverrides(dir)
    assert.deepEqual(missing.overrides, {})
    assert.match(missing.problem ?? '', /missing/)
    assert.deepEqual(applyOverrides('phi:python@1', dir), { ref: 'phi:python@1', warnings: [] })

    const file = join(dir, '.phi', 'environments.json')
    mkdirSync(join(dir, '.phi'), { recursive: true })
    writeFileSync(file, '{')
    assert.deepEqual(readOverrides(dir).overrides, {})
    assert.match(readOverrides(dir).problem ?? '', /invalid/)

    writeFileSync(file, JSON.stringify({ version: 2, overrides: {} }))
    assert.match(readOverrides(dir).problem ?? '', /invalid/)
    writeFileSync(file, JSON.stringify({ version: 1, overrides: {}, extra: true }))
    assert.match(readOverrides(dir).problem ?? '', /invalid/)
    writeFileSync(
      file,
      JSON.stringify({ version: 1, overrides: { 'phi:python@1': 'phi:python@1' } })
    )
    assert.match(readOverrides(dir).problem ?? '', /invalid/)
    assert.deepEqual(applyOverrides('phi:python@1', dir), { ref: 'phi:python@1', warnings: [] })

    setOverride(dir, 'phi:python@1', 'project:python-x1')
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {
      version: 1,
      overrides: { 'phi:python@1': 'project:python-x1' }
    })
    assert.equal(
      readdirSync(join(dir, '.phi')).some((name) => name.includes('.tmp')),
      false
    )
    const ignored = applyOverrides('phi:python@1', dir)
    assert.equal(ignored.ref, 'phi:python@1')
    assert.match(ignored.warnings[0] ?? '', /missing project environment 'project:python-x1'/)

    assert.throws(() => setOverride(dir, 'not a ref', 'project:python-x1'))
    assert.throws(() => setOverride(dir, 'phi:python@1', 'plugin:demo'), /project:/)

    writeFileSync(file, 'not json')
    setOverride(dir, 'plugin:demo', 'project:demo-x1')
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {
      version: 1,
      overrides: { 'plugin:demo': 'project:demo-x1' }
    })

    const spec = minimalSpec('python-x1')
    writeProjectEnvironment(dir, {
      name: 'python-x1',
      spec,
      lockText: lockText(platform),
      platform
    })
    writeProjectEnvironment(dir, {
      name: 'python-x2',
      spec: { ...spec, name: 'python-x2' },
      lockText: lockText(platform),
      platform
    })
    writeOverrides(dir, {
      'phi:python@1': 'project:python-x1',
      'project:python-x1': 'project:python-x2'
    })
    assert.deepEqual(applyOverrides('phi:python@1', dir), {
      ref: 'project:python-x1',
      warnings: []
    })
    assert.equal(applyOverrides('project:python-x1', dir).ref, 'project:python-x2')
    assert.deepEqual(applyOverrides('plugin:demo', dir), { ref: 'plugin:demo', warnings: [] })

    const described = describeEnvironment('project:python-x1', { projectDir: dir, platform })
    assert.equal(described.scope, 'project')
    assert.equal(described.kind, 'project')
    assert.equal(described.owner, projectOwner(dir))
    assert.equal(described.spec.name, 'python-x1')
    assert.equal(described.ref, 'project:python-x1')
    assert.throws(
      () => describeEnvironment('project:python-x1', { platform }),
      /project environment requires a project directory/
    )
  } finally {
    remove(dir)
  }
})
