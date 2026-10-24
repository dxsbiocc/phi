import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { e5SmokeGate, E5_SMOKE_PROJECT_ID } from '../src/main/agent/remote-session-routing'
import type { Project } from '../src/main/agent/projects'

test('E5 route opens only for the exact isolated development phi-test launch', () => {
  const root = mkdtempSync('/tmp/phi-e5-')
  const agentDir = join(root, 'home', '.phi')
  const userData = join(root, 'user-data')
  const homeDir = join(root, 'home')
  mkdirSync(agentDir, { recursive: true })
  mkdirSync(userData)
  const location: Extract<Project['location'], { kind: 'ssh' }> = {
    kind: 'ssh',
    hostProfileId: 'ssh-config:GPU',
    remoteRoot: '/data2/dengxsh/phi-test',
    canonicalRoot: '/data2/dengxsh/phi-test'
  }
  const project = {
    id: E5_SMOKE_PROJECT_ID,
    name: 'phi-test',
    location
  } as Project
  const input = {
    argv: ['electron', `--user-data-dir=${userData}`, '--e5-smoke'],
    devRendererUrl: 'http://localhost:5173',
    isDevelopment: true,
    isPackaged: false,
    agentDir,
    homeDir,
    runtimeHomeDir: homeDir,
    actualUserDataPath: userData,
    project
  }
  try {
    assert.equal(e5SmokeGate(input), true)
    assert.equal(e5SmokeGate({ ...input, isPackaged: true }), false)
    assert.equal(e5SmokeGate({ ...input, isDevelopment: false }), false)
    assert.equal(e5SmokeGate({ ...input, devRendererUrl: undefined }), false)
    assert.equal(
      e5SmokeGate({ ...input, argv: input.argv.filter((x) => x !== '--e5-smoke') }),
      false
    )
    assert.equal(e5SmokeGate({ ...input, argv: ['electron', '--e5-smoke'] }), false)
    assert.equal(e5SmokeGate({ ...input, agentDir: '/tmp/not-isolated/.phi' }), false)
    assert.equal(e5SmokeGate({ ...input, homeDir: '/tmp' }), false)
    assert.equal(e5SmokeGate({ ...input, runtimeHomeDir: '/tmp' }), false)
    assert.equal(e5SmokeGate({ ...input, actualUserDataPath: '/tmp' }), false)
    assert.equal(
      e5SmokeGate({ ...input, argv: ['electron', '--e5-smoke', '--user-data-dir=/tmp'] }),
      false
    )
    assert.equal(e5SmokeGate({ ...input, project: { ...project, id: 'other' } }), false)
    assert.equal(e5SmokeGate({ ...input, project: { ...project, name: 'other' } }), false)
    assert.equal(
      e5SmokeGate({
        ...input,
        project: {
          ...project,
          location: { ...location, hostProfileId: 'ssh-config:other' }
        }
      }),
      false
    )
    assert.equal(
      e5SmokeGate({
        ...input,
        project: { ...project, location: { ...location, canonicalRoot: '/other' } }
      }),
      false
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
