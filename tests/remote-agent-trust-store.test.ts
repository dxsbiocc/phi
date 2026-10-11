import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'

import {
  remoteAgentTrustStorePath,
  remoteAgentTrustState,
  revokeRemoteProjectAgentTrust,
  trustRemoteProjectAgent
} from '../src/main/agent/agents/remote-agent-trust-store'

const temporaryDirectories: string[] = []

function makeAgentDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'phi-remote-agent-trust-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('trust is scoped to the host, normalized project root, relative path and content hash', () => {
  const agentDir = makeAgentDir()
  const identity = {
    hostAlias: 'lab',
    projectRoot: '/srv/shared/project/',
    relativePath: '.phi/agents/Reviewer.md',
    contentHash: 'a'.repeat(64)
  }

  assert.equal(remoteAgentTrustState(identity, agentDir), 'pending')
  trustRemoteProjectAgent(identity, agentDir)

  assert.equal(
    remoteAgentTrustState({ ...identity, projectRoot: '/srv/shared/project' }, agentDir),
    'trusted'
  )
  assert.equal(remoteAgentTrustState({ ...identity, hostAlias: 'other' }, agentDir), 'pending')
  assert.equal(
    remoteAgentTrustState({ ...identity, relativePath: '.phi/agents/Other.md' }, agentDir),
    'pending'
  )
  assert.equal(
    remoteAgentTrustState({ ...identity, contentHash: 'b'.repeat(64) }, agentDir),
    'changed'
  )
})

test('content changes invalidate trust until the new hash is trusted and revoke returns to pending', () => {
  const agentDir = makeAgentDir()
  const original = {
    hostAlias: 'lab',
    projectRoot: '/srv/project',
    relativePath: '.omp/agents/Reviewer.md',
    contentHash: '1'.repeat(64)
  }
  const changed = { ...original, contentHash: '2'.repeat(64) }

  trustRemoteProjectAgent(original, agentDir)
  assert.equal(remoteAgentTrustState(changed, agentDir), 'changed')

  trustRemoteProjectAgent(changed, agentDir)
  assert.equal(remoteAgentTrustState(changed, agentDir), 'trusted')
  assert.equal(remoteAgentTrustState(original, agentDir), 'changed')

  revokeRemoteProjectAgentTrust(changed, agentDir)
  assert.equal(remoteAgentTrustState(changed, agentDir), 'pending')
})

test('trust entries are atomically stored in a private local JSON file without agent content', () => {
  const agentDir = makeAgentDir()
  const first = {
    hostAlias: 'lab',
    projectRoot: '/srv/project',
    relativePath: '.phi/agents/Reviewer.md',
    contentHash: 'a'.repeat(64)
  }
  const second = {
    ...first,
    hostAlias: 'cluster',
    contentHash: 'b'.repeat(64)
  }

  trustRemoteProjectAgent(first, agentDir)
  const path = remoteAgentTrustStorePath(agentDir)
  chmodSync(path, 0o644)
  trustRemoteProjectAgent(second, agentDir)

  const document = JSON.parse(readFileSync(path, 'utf8')) as {
    version: number
    entries: Array<Record<string, unknown>>
  }
  assert.equal(statSync(path).mode & 0o777, 0o600)
  assert.equal(document.version, 1)
  assert.equal(document.entries.length, 2)
  assert.equal(JSON.stringify(document).includes('systemPrompt'), false)
  assert.deepEqual(
    readdirSync(agentDir).filter((name) => name.endsWith('.tmp')),
    []
  )
})

test('trust rejects malformed host, project, path and hash key parts before writing', () => {
  const agentDir = makeAgentDir()
  const identity = {
    hostAlias: 'lab',
    projectRoot: '/srv/project',
    relativePath: '.phi/agents/Reviewer.md',
    contentHash: 'a'.repeat(64)
  }

  assert.throws(() => trustRemoteProjectAgent({ ...identity, hostAlias: 'lab\nother' }, agentDir))
  assert.throws(() => trustRemoteProjectAgent({ ...identity, projectRoot: 'relative' }, agentDir))
  assert.throws(() =>
    trustRemoteProjectAgent({ ...identity, relativePath: '../outside/Reviewer.md' }, agentDir)
  )
  assert.throws(() => trustRemoteProjectAgent({ ...identity, contentHash: 'not-a-hash' }, agentDir))
  assert.equal(readdirSync(agentDir).length, 0)
})
