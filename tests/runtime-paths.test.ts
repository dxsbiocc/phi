import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

import {
  getAdditionalProjectResourcePaths,
  getGlobalMcpConfigPaths,
  getPhiProjectDir,
  getKnownProjectResourceBaseDir,
  getProjectMcpConfigPaths
} from '../src/main/agent/runtime-paths'

test('runtime paths keep Phi-owned project config ahead of legacy runtime config', () => {
  const cwd = '/projects/demo'
  const agentDir = '/users/example/.phi'

  assert.equal(getPhiProjectDir(cwd), join(cwd, '.phi'))
  assert.deepEqual(getGlobalMcpConfigPaths(agentDir), [
    join(agentDir, 'mcp.json'),
    join(agentDir, 'mcpServers.json'),
    join(agentDir, 'settings.json')
  ])
  assert.deepEqual(getProjectMcpConfigPaths(cwd), [
    join(cwd, '.phi', 'mcp.json'),
    join(cwd, '.mcp.json'),
    join(cwd, '.omp', 'mcp.json'),
    join(cwd, '.pi', 'mcp.json')
  ])
  assert.deepEqual(getAdditionalProjectResourcePaths(cwd, 'skills'), [
    join(cwd, '.phi', 'skills'),
    join(cwd, '.pi', 'skills')
  ])
})

test('runtime paths classify Phi and legacy project resources as project scoped', () => {
  const cwd = '/projects/demo'

  assert.equal(
    getKnownProjectResourceBaseDir(cwd, 'skills', join(cwd, '.phi', 'skills', 'audit', 'SKILL.md')),
    join(cwd, '.phi', 'skills')
  )
  assert.equal(
    getKnownProjectResourceBaseDir(cwd, 'skills', join(cwd, '.omp', 'skills', 'audit', 'SKILL.md')),
    join(cwd, '.omp', 'skills')
  )
  assert.equal(getKnownProjectResourceBaseDir(cwd, 'skills', '/tmp/audit/SKILL.md'), undefined)
})
