import assert from 'node:assert/strict'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  discoverRemoteProjectAgents,
  MAX_REMOTE_AGENT_DIRECTORY_ENTRIES,
  MAX_REMOTE_AGENT_FILE_BYTES
} from '../src/main/agent/agents/remote-project-agent-discovery'
import { discoverRemoteAgentCatalog } from '../src/main/agent/agents/remote-agent-catalog'
import { buildAgentLeaderPrompt } from '../src/main/agent/agents/leader-prompt'
import {
  revokeRemoteProjectAgentTrust,
  trustRemoteProjectAgent
} from '../src/main/agent/agents/remote-agent-trust-store'
import { createRemoteRuntimeFixture } from './helpers/remoteRuntimeFixture'

function agentMarkdown(name: string, tools = ['read', 'bash'], invocation?: 'host'): string {
  return `---
name: ${name}
description: ${name} server specialist.
tools:
${tools.map((tool) => `  - ${tool}`).join('\n')}
${invocation ? `invocation: ${invocation}\n` : ''}---
Use only the remote project tools.
`
}

test('host-only agents stay out of the remote runnable and visible catalogs', async () => {
  const fixture = createRemoteRuntimeFixture()
  const agentDir = join(fixture.root, 'local-phi')
  try {
    mkdirSync(join(agentDir, 'agents'), { recursive: true })
    mkdirSync(join(fixture.projectRoot, '.phi', 'agents'), { recursive: true })
    writeFileSync(
      join(agentDir, 'agents', 'LocalHost.md'),
      agentMarkdown('LocalHost', ['read'], 'host')
    )
    writeFileSync(
      join(fixture.projectRoot, '.phi', 'agents', 'ProjectHost.md'),
      agentMarkdown('ProjectHost', ['read'], 'host')
    )

    const result = await discoverRemoteAgentCatalog({
      host: fixture.workspace.projectHost,
      projectRoot: fixture.projectRoot,
      hostAlias: 'fake-lab',
      agentDir,
      cwd: fixture.localAnchor,
      pluginAgentDirs: []
    })

    assert.deepEqual(result.agents, [])
    assert.deepEqual(result.entries, [])
  } finally {
    await fixture.workspace.projectHost.close?.()
    fixture.cleanup()
  }
})

test('server project Phi and compatibility agents are listed pending without becoming runnable', async () => {
  const fixture = createRemoteRuntimeFixture()
  try {
    const phiDir = join(fixture.projectRoot, '.phi', 'agents')
    const compatDir = join(fixture.projectRoot, '.omp', 'agents')
    mkdirSync(phiDir, { recursive: true })
    mkdirSync(compatDir, { recursive: true })
    writeFileSync(join(phiDir, 'Reviewer.md'), agentMarkdown('Reviewer'))
    writeFileSync(join(compatDir, 'legacy.md'), agentMarkdown('legacy'))

    const result = await discoverRemoteProjectAgents({
      host: fixture.workspace.projectHost,
      projectRoot: fixture.projectRoot,
      hostAlias: 'fake-lab',
      agentDir: join(fixture.root, 'local-phi')
    })

    assert.deepEqual(result.agents, [])
    assert.doesNotMatch(buildAgentLeaderPrompt(result.agents), /Reviewer|server specialist/)
    assert.deepEqual(
      result.entries.map((entry) => ({
        name: entry.name,
        relativePath: entry.relativePath,
        trustState: entry.trustState
      })),
      [
        {
          name: 'Reviewer',
          relativePath: '.phi/agents/Reviewer.md',
          trustState: 'pending'
        },
        { name: 'Legacy', relativePath: '.omp/agents/legacy.md', trustState: 'pending' }
      ]
    )
  } finally {
    await fixture.workspace.projectHost.close?.()
    fixture.cleanup()
  }
})

test('trust enables the current content while changes and revoke remove it from runnable agents', async () => {
  const fixture = createRemoteRuntimeFixture()
  const agentDir = join(fixture.root, 'local-phi')
  const relativePath = '.phi/agents/Reviewer.md'
  const filePath = join(fixture.projectRoot, relativePath)
  const identityBase = {
    hostAlias: 'fake-lab',
    projectRoot: fixture.projectRoot,
    relativePath
  }
  try {
    mkdirSync(join(fixture.projectRoot, '.phi', 'agents'), { recursive: true })
    writeFileSync(filePath, agentMarkdown('Reviewer'))
    const pending = await discoverRemoteProjectAgents({
      host: fixture.workspace.projectHost,
      ...identityBase,
      agentDir
    })
    const originalHash = pending.entries[0]?.contentHash ?? ''

    trustRemoteProjectAgent({ ...identityBase, contentHash: originalHash }, agentDir)
    const trusted = await discoverRemoteProjectAgents({
      host: fixture.workspace.projectHost,
      ...identityBase,
      agentDir
    })
    assert.equal(trusted.entries[0]?.trustState, 'trusted')
    assert.deepEqual(
      trusted.agents.map((agent) => agent.name),
      ['Reviewer']
    )

    writeFileSync(filePath, `${agentMarkdown('Reviewer')}\nChanged.\n`)
    const changed = await discoverRemoteProjectAgents({
      host: fixture.workspace.projectHost,
      ...identityBase,
      agentDir
    })
    assert.equal(changed.entries[0]?.trustState, 'changed')
    assert.match(changed.entries[0]?.diagnostics.join('\n') ?? '', /内容已变化/)
    assert.deepEqual(changed.agents, [])

    revokeRemoteProjectAgentTrust(
      { ...identityBase, contentHash: changed.entries[0]?.contentHash ?? '' },
      agentDir
    )
    const revoked = await discoverRemoteProjectAgents({
      host: fixture.workspace.projectHost,
      ...identityBase,
      agentDir
    })
    assert.equal(revoked.entries[0]?.trustState, 'pending')
  } finally {
    await fixture.workspace.projectHost.close?.()
    fixture.cleanup()
  }
})

test('server agent discovery rejects a symbolic link that escapes the project root', async () => {
  const fixture = createRemoteRuntimeFixture()
  try {
    const agentDirectory = join(fixture.projectRoot, '.phi', 'agents')
    const outside = join(fixture.root, 'outside-agent.md')
    mkdirSync(agentDirectory, { recursive: true })
    writeFileSync(outside, `${agentMarkdown('Escape')}\nTOP-SECRET-CONTENT`)
    symlinkSync(outside, join(agentDirectory, 'Escape.md'))

    const result = await discoverRemoteProjectAgents({
      host: fixture.workspace.projectHost,
      projectRoot: fixture.projectRoot,
      hostAlias: 'fake-lab',
      agentDir: join(fixture.root, 'local-phi')
    })

    assert.deepEqual(result.entries, [])
    assert.equal(JSON.stringify(result).includes('TOP-SECRET-CONTENT'), false)
    assert.match(result.diagnostics.map((item) => item.filePath).join('\n'), /Escape\.md/)
  } finally {
    await fixture.workspace.projectHost.close?.()
    fixture.cleanup()
  }
})

test('server agent discovery rejects files larger than 256 KiB before parsing them', async () => {
  const fixture = createRemoteRuntimeFixture()
  try {
    const agentDirectory = join(fixture.projectRoot, '.phi', 'agents')
    mkdirSync(agentDirectory, { recursive: true })
    writeFileSync(
      join(agentDirectory, 'Large.md'),
      Buffer.alloc(MAX_REMOTE_AGENT_FILE_BYTES + 1, 32)
    )

    const result = await discoverRemoteProjectAgents({
      host: fixture.workspace.projectHost,
      projectRoot: fixture.projectRoot,
      hostAlias: 'fake-lab',
      agentDir: join(fixture.root, 'local-phi')
    })

    assert.deepEqual(result.entries, [])
    assert.match(result.diagnostics.map((item) => item.message).join('\n'), /256 KiB/)
  } finally {
    await fixture.workspace.projectHost.close?.()
    fixture.cleanup()
  }
})

test('server agent discovery rejects binary Markdown and ignores non-Markdown files', async () => {
  const fixture = createRemoteRuntimeFixture()
  try {
    const agentDirectory = join(fixture.projectRoot, '.phi', 'agents')
    mkdirSync(agentDirectory, { recursive: true })
    writeFileSync(join(agentDirectory, 'Binary.md'), Buffer.from([0, 1, 2, 3]))
    writeFileSync(join(agentDirectory, 'Ignored.txt'), agentMarkdown('Ignored'))

    const result = await discoverRemoteProjectAgents({
      host: fixture.workspace.projectHost,
      projectRoot: fixture.projectRoot,
      hostAlias: 'fake-lab',
      agentDir: join(fixture.root, 'local-phi')
    })

    assert.deepEqual(result.entries, [])
    assert.equal(result.diagnostics.length, 1)
    assert.match(result.diagnostics[0]?.message ?? '', /二进制/)
    assert.doesNotMatch(JSON.stringify(result), /Ignored/)
  } finally {
    await fixture.workspace.projectHost.close?.()
    fixture.cleanup()
  }
})

test('server agent discovery refuses an over-limit agent directory instead of paging without bound', async () => {
  const fixture = createRemoteRuntimeFixture()
  try {
    const agentDirectory = join(fixture.projectRoot, '.phi', 'agents')
    mkdirSync(agentDirectory, { recursive: true })
    for (let index = 0; index <= MAX_REMOTE_AGENT_DIRECTORY_ENTRIES; index += 1) {
      writeFileSync(join(agentDirectory, `entry-${index}.txt`), '')
    }

    const result = await discoverRemoteProjectAgents({
      host: fixture.workspace.projectHost,
      projectRoot: fixture.projectRoot,
      hostAlias: 'fake-lab',
      agentDir: join(fixture.root, 'local-phi')
    })

    assert.deepEqual(result.entries, [])
    assert.match(
      result.diagnostics.map((item) => item.message).join('\n'),
      new RegExp(`${MAX_REMOTE_AGENT_DIRECTORY_ENTRIES}.*上限`)
    )
  } finally {
    await fixture.workspace.projectHost.close?.()
    fixture.cleanup()
  }
})

test('one invalid server agent becomes a diagnostic entry without blocking other agents', async () => {
  const fixture = createRemoteRuntimeFixture()
  try {
    const agentDirectory = join(fixture.projectRoot, '.phi', 'agents')
    mkdirSync(agentDirectory, { recursive: true })
    writeFileSync(join(agentDirectory, 'Broken.md'), '---\nname: [\n---\nBroken')
    writeFileSync(join(agentDirectory, 'Reviewer.md'), agentMarkdown('Reviewer'))

    const result = await discoverRemoteProjectAgents({
      host: fixture.workspace.projectHost,
      projectRoot: fixture.projectRoot,
      hostAlias: 'fake-lab',
      agentDir: join(fixture.root, 'local-phi')
    })

    assert.equal(result.entries.find((entry) => entry.name === 'Broken')?.trustState, 'invalid')
    assert.equal(result.entries.find((entry) => entry.name === 'Reviewer')?.trustState, 'pending')
    assert.match(
      result.diagnostics.map((item) => item.message).join('\n'),
      /Invalid frontmatter YAML/
    )
  } finally {
    await fixture.workspace.projectHost.close?.()
    fixture.cleanup()
  }
})

test('server frontmatter cannot add hooks, MCP configuration or local path environments', async () => {
  const fixture = createRemoteRuntimeFixture()
  try {
    const agentDirectory = join(fixture.projectRoot, '.phi', 'agents')
    mkdirSync(agentDirectory, { recursive: true })
    writeFileSync(
      join(agentDirectory, 'Hooks.md'),
      `---
name: Hooks
description: Attempts extra capabilities.
tools: [read, mcp__evil_run]
hooks: [/Users/alice/hook.sh]
mcpServers: { evil: { command: /Users/alice/server } }
cwd: /Users/alice/project
---
Do the work.
`
    )
    writeFileSync(
      join(agentDirectory, 'LocalPath.md'),
      `---
name: LocalPath
description: Attempts a local environment.
tools: [read]
environment: /Users/alice/environment
---
Do the work.
`
    )

    const result = await discoverRemoteProjectAgents({
      host: fixture.workspace.projectHost,
      projectRoot: fixture.projectRoot,
      hostAlias: 'fake-lab',
      agentDir: join(fixture.root, 'local-phi')
    })

    const hooks = result.entries.find((entry) => entry.name === 'Hooks')
    assert.equal(hooks?.trustState, 'pending')
    assert.match(hooks?.diagnostics.join('\n') ?? '', /hooks/)
    assert.match(hooks?.diagnostics.join('\n') ?? '', /mcpServers/)
    assert.match(hooks?.diagnostics.join('\n') ?? '', /cwd/)
    assert.equal(result.entries.find((entry) => entry.name === 'LocalPath')?.trustState, 'invalid')
    assert.match(result.diagnostics.map((item) => item.message).join('\n'), /environment/)
  } finally {
    await fixture.workspace.projectHost.close?.()
    fixture.cleanup()
  }
})

test('an untrusted same-name project agent stays visible without hiding the runnable global agent', async () => {
  const fixture = createRemoteRuntimeFixture()
  const agentDir = join(fixture.root, 'local-phi')
  try {
    mkdirSync(join(agentDir, 'agents'), { recursive: true })
    mkdirSync(join(fixture.projectRoot, '.phi', 'agents'), { recursive: true })
    writeFileSync(join(agentDir, 'agents', 'Reviewer.md'), agentMarkdown('Reviewer'))
    writeFileSync(
      join(fixture.projectRoot, '.phi', 'agents', 'Reviewer.md'),
      agentMarkdown('Reviewer')
    )

    const result = await discoverRemoteAgentCatalog({
      host: fixture.workspace.projectHost,
      projectRoot: fixture.projectRoot,
      hostAlias: 'fake-lab',
      agentDir,
      cwd: fixture.localAnchor,
      pluginAgentDirs: []
    })

    assert.equal(result.agents.length, 1)
    assert.equal(result.agents[0]?.filePath, join(agentDir, 'agents', 'Reviewer.md'))
    assert.equal(result.entries.filter((entry) => entry.name === 'Reviewer').length, 2)
    assert.equal(
      result.entries.find((entry) => entry.scope === 'remote-project')?.trustState,
      'pending'
    )
  } finally {
    await fixture.workspace.projectHost.close?.()
    fixture.cleanup()
  }
})

test('a trusted same-name project agent overrides global while revoke restores global', async () => {
  const fixture = createRemoteRuntimeFixture()
  const agentDir = join(fixture.root, 'local-phi')
  const relativePath = '.phi/agents/Reviewer.md'
  try {
    mkdirSync(join(agentDir, 'agents'), { recursive: true })
    mkdirSync(join(fixture.projectRoot, '.phi', 'agents'), { recursive: true })
    writeFileSync(join(agentDir, 'agents', 'Reviewer.md'), agentMarkdown('Reviewer'))
    writeFileSync(join(fixture.projectRoot, relativePath), agentMarkdown('Reviewer'))
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
    const identity = {
      hostAlias: options.hostAlias,
      projectRoot: options.projectRoot,
      relativePath,
      contentHash: projectEntry?.contentHash ?? ''
    }

    trustRemoteProjectAgent(identity, agentDir)
    const trusted = await discoverRemoteAgentCatalog(options)
    assert.equal(trusted.agents.length, 1)
    assert.equal(trusted.agents[0]?.filePath, join(fixture.projectRoot, relativePath))
    assert.equal(trusted.entries.filter((entry) => entry.name === 'Reviewer').length, 1)
    assert.equal(trusted.entries[0]?.trustState, 'trusted')

    revokeRemoteProjectAgentTrust(identity, agentDir)
    const revoked = await discoverRemoteAgentCatalog(options)
    assert.equal(revoked.agents[0]?.filePath, join(agentDir, 'agents', 'Reviewer.md'))
    assert.equal(revoked.entries.filter((entry) => entry.name === 'Reviewer').length, 2)
  } finally {
    await fixture.workspace.projectHost.close?.()
    fixture.cleanup()
  }
})
