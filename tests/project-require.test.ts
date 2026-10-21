import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createProject, requireProject } from '../src/main/agent/projects'

test('requireProject returns the stored project', () => {
  const workingDirectory = mkdtempSync(join(tmpdir(), 'phi-require-project-'))
  try {
    const project = createProject({ name: 'Require', workingDirectory, permissionMode: 'auto' })
    const required = requireProject(project.id)
    assert.equal(required.id, project.id)
    assert.equal(required.name, 'Require')
  } finally {
    rmSync(workingDirectory, { recursive: true, force: true })
  }
})

test('requireProject rejects an unknown project id', () => {
  assert.throws(() => requireProject('missing-project-id'), /项目不存在/)
})
