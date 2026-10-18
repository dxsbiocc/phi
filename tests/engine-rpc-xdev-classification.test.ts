import assert from 'node:assert/strict'
import test from 'node:test'
import {
  classifyXdevCall,
  isXdevDevicePath
} from '../src/main/agent/engine/phi-extension/lib/rpc-xdev'
import { projectToolBoundaryDecision } from '../src/main/agent/engine/phi-extension/lib/project-boundary'

test('canonical xd:// spellings are classified, everything else that mentions the scheme is refused', () => {
  assert.deepEqual(classifyXdevCall('read', { path: 'xd://' }), { kind: 'discovery' })
  assert.deepEqual(classifyXdevCall('read', { path: 'xd://mcp__srv_tool' }), { kind: 'discovery' })
  assert.deepEqual(classifyXdevCall('write', { path: 'xd://tool_1', content: '{}' }), {
    kind: 'dispatch',
    name: 'tool_1'
  })
  const refused = [
    ['write', { path: 'xd://', content: '{}' }],
    ['write', { path: 'xd://tool', content: 1 }],
    ['write', { path: 'xd://tool', content: '{}', extra: true }],
    ['write', { path: 'XD://tool', content: '{}' }],
    ['write', { path: ' xd://tool', content: '{}' }],
    ['write', { path: '[xd://tool#AB]', content: '{}' }],
    ['write', { path: 'xd://tool/topic', content: '{}' }],
    ['write', { path: 'xd://tool?x=1', content: '{}' }],
    ['read', { path: 'xd://tool:raw' }],
    ['read', { path: 'xd://a/b' }],
    ['read', { path: 'xd://tool', sel: 'raw' }],
    ['edit', { path: 'xd://tool' }],
    ['grep', { pattern: 'x', paths: ['src', 'xd://tool'] }],
    ['glob', { path: 'xd://tool' }]
  ] as const
  for (const [tool, input] of refused)
    assert.deepEqual(classifyXdevCall(tool, input), { kind: 'refused' }, JSON.stringify(input))
  for (const [tool, input] of [
    ['read', { path: 'src/index.ts' }],
    ['write', { path: 'notes.md', content: 'xd://not-a-path-field' }],
    ['bash', { command: 'echo xd://tool' }],
    ['xd_host_0', { path: 'xd://tool' }]
  ] as const)
    assert.equal(classifyXdevCall(tool, input), undefined, JSON.stringify(input))
})

test('the project boundary does not resolve canonical device URLs as filesystem paths', () => {
  assert.equal(isXdevDevicePath('xd://tool'), true)
  assert.equal(isXdevDevicePath('xd://../tool'), false)
  assert.deepEqual(
    projectToolBoundaryDecision('/definitely/not/a/dir', 'read', { path: 'xd://' }),
    {
      allowed: true
    }
  )
  assert.equal(
    projectToolBoundaryDecision(process.cwd(), 'read', { path: '../outside' }).allowed,
    false
  )
})
