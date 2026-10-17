import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { readRegistry } from '../src/main/agent/packages/registry'

const roots: string[] = []
test.after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })))

function index(): Record<string, unknown> & { packages: Record<string, unknown>[] } {
  return {
    schemaVersion: 1,
    generatedAt: '2026-10-17T04:00:00.000Z',
    skillGroups: [
      { id: 'all', label: '全部', count: 1 },
      { id: 'science', label: '科学分析', count: 1 },
      { id: 'other', label: '其他', count: 0 }
    ],
    packages: [
      {
        id: 'scanpy',
        type: 'skill',
        version: '1.3.0',
        title: 'Scanpy',
        summary: 'Analysis',
        archive: 'skill-scanpy.tar.gz',
        sha256: 'a'.repeat(64),
        size: 10,
        group: 'science',
        groupLabel: '科学分析',
        groupOrder: 1
      }
    ]
  }
}

function read(value: unknown): ReturnType<typeof readRegistry> {
  const root = mkdtempSync(join(tmpdir(), 'phi-registry-skill-groups-'))
  roots.push(root)
  writeFileSync(join(root, 'index.json'), JSON.stringify(value))
  return readRegistry(root)
}

test('verified registry reads preserve API group membership, labels, order and empty groups', () => {
  const source = index()
  const registry = read(source)
  assert.deepEqual(registry.skillGroups, source.skillGroups)
  assert.equal(registry.packages[0].group, 'science')
  assert.equal(registry.packages[0].groupLabel, '科学分析')
  assert.equal(registry.packages[0].groupOrder, 1)
  assert.equal(registry.trust, 'imported')
})

test('malformed registry group metadata is rejected without changing legacy registry support', () => {
  for (const invalid of [
    [{ id: 'science', label: '科学分析', count: -1 }],
    [{ id: '../escape', label: '科学分析', count: 1 }],
    [{ id: 'science', label: '', count: 1 }],
    [
      { id: 'science', label: '科学分析', count: 1 },
      { id: 'science', label: '重复', count: 1 }
    ]
  ]) {
    assert.throws(() => read({ ...index(), skillGroups: invalid }), /skillGroups/)
  }
  for (const invalid of [
    { groupOrder: -1 },
    { groupLabel: '' },
    { group: '../escape' },
    { type: 'mcp' }
  ]) {
    const source = index()
    source.packages[0] = { ...source.packages[0], ...invalid }
    assert.throws(() => read(source), /group/)
  }
  const legacy = index()
  delete legacy.skillGroups
  for (const field of ['group', 'groupLabel', 'groupOrder']) delete legacy.packages[0][field]
  assert.equal(read(legacy).packages[0].id, 'scanpy')
})
