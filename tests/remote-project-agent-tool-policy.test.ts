import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { discoverRemoteAgentCatalog } from '../src/main/agent/agents/remote-agent-catalog'
import { trustRemoteAgent } from '../src/main/agent/agents/remote-agent-service'
import { trustRemoteProjectAgent } from '../src/main/agent/agents/remote-agent-trust-store'
import { assertBoundaryIdentity } from './helpers/remoteBoundaryIdentity'
import { createRemoteRuntimeFixture } from './helpers/remoteRuntimeFixture'

function agentMarkdown(name: string, tools = ['read', 'bash']): string {
  return `---
name: ${name}
description: ${name} server specialist.
tools:
${tools.map((tool) => `  - ${tool}`).join('\n')}
---
Use only the remote project tools.
`
}

test('a trusted but tool-incompatible project agent is unavailable and does not fall back by name', async () => {
  const fixture = createRemoteRuntimeFixture()
  const agentDir = join(fixture.root, 'local-phi')
  const relativePath = '.phi/agents/Reviewer.md'
  try {
    mkdirSync(join(agentDir, 'agents'), { recursive: true })
    mkdirSync(join(fixture.projectRoot, '.phi', 'agents'), { recursive: true })
    writeFileSync(join(agentDir, 'agents', 'Reviewer.md'), agentMarkdown('Reviewer'))
    writeFileSync(join(fixture.projectRoot, relativePath), agentMarkdown('Reviewer', ['browser']))
    const options = {
      host: fixture.workspace.projectHost,
      projectRoot: fixture.projectRoot,
      hostAlias: 'fake-lab',
      agentDir,
      cwd: fixture.localAnchor,
      pluginAgentDirs: []
    }
    const pending = await discoverRemoteAgentCatalog(options)
    const projectEntry = pending.entries.find((entry) => entry.scope === 'remote-project')
    trustRemoteProjectAgent(
      {
        hostAlias: options.hostAlias,
        projectRoot: options.projectRoot,
        relativePath,
        contentHash: projectEntry?.contentHash ?? ''
      },
      agentDir
    )

    const trusted = await discoverRemoteAgentCatalog(options)

    assert.deepEqual(trusted.agents, [])
    assert.equal(trusted.entries.length, 1)
    assert.equal(trusted.entries[0]?.available, false)
    assert.match(trusted.entries[0]?.diagnostics?.join('\n') ?? '', /read.*bash/)
  } finally {
    await fixture.workspace.projectHost.close?.()
    fixture.cleanup()
  }
})

test('a trusted project agent keeps the remote-safe tool intersection and reports every dropped tool', async () => {
  const fixture = createRemoteRuntimeFixture()
  const agentDir = join(fixture.root, 'local-phi')
  const relativePath = '.phi/agents/Reviewer.md'
  try {
    mkdirSync(join(fixture.projectRoot, '.phi', 'agents'), { recursive: true })
    writeFileSync(
      join(fixture.projectRoot, relativePath),
      agentMarkdown('Reviewer', ['read', 'office_read', 'lib_save', 'mcp__evil_run'])
    )
    const options = {
      host: fixture.workspace.projectHost,
      projectRoot: fixture.projectRoot,
      hostAlias: 'fake-lab',
      agentDir,
      cwd: fixture.localAnchor,
      pluginAgentDirs: []
    }
    const pending = await discoverRemoteAgentCatalog(options)
    trustRemoteProjectAgent(
      {
        hostAlias: options.hostAlias,
        projectRoot: options.projectRoot,
        relativePath,
        contentHash: pending.entries[0]?.contentHash ?? ''
      },
      agentDir
    )

    const trusted = await discoverRemoteAgentCatalog(options)

    assert.equal(trusted.agents.length, 1)
    assert.deepEqual(trusted.agents[0]?.tools, ['read'])
    assert.equal(trusted.entries[0]?.available, true)
    assert.deepEqual(trusted.entries[0]?.diagnostics, [
      '该 agent 在远程项目中缺少：office_read',
      '该 agent 在远程项目中缺少：lib_save',
      '该 agent 在远程项目中缺少：mcp__evil_run'
    ])
  } finally {
    await fixture.workspace.projectHost.close?.()
    fixture.cleanup()
  }
})

test('trust mutation re-reads the server file and rejects a stale renderer hash', async () => {
  const fixture = createRemoteRuntimeFixture()
  const agentDir = join(fixture.root, 'local-phi')
  const relativePath = '.phi/agents/Reviewer.md'
  try {
    mkdirSync(join(fixture.projectRoot, '.phi', 'agents'), { recursive: true })
    writeFileSync(join(fixture.projectRoot, relativePath), agentMarkdown('Reviewer'))

    await assert.rejects(
      trustRemoteAgent(
        {
          sessionId: 'session-1',
          projectId: 'project-1',
          cwd: fixture.localAnchor,
          agentDir,
          bundledDir: join(fixture.root, 'bundled')
        },
        { relativePath, contentHash: 'f'.repeat(64) },
        {
          resolveBinding: (input: unknown) => {
            assertBoundaryIdentity(input)
            return {
              sessionId: 'session-1',
              projectId: 'project-1',
              hostAlias: 'fake-lab',
              remoteRoot: fixture.projectRoot,
              canonicalRoot: fixture.projectRoot,
              cacheKey: 'test',
              config: {
                remoteRoot: fixture.projectRoot,
                canonicalRoot: fixture.projectRoot,
                connect: fixture.connect
              }
            }
          },
          createHost: () => fixture.workspace.projectHost
        }
      ),
      /已变化|刷新/
    )
  } finally {
    fixture.cleanup()
  }
})
