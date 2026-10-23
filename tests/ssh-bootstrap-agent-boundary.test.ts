import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'

import { AgentRunRegistry } from '../src/main/agent/agents/registry'
import { buildAgentRunTools } from '../src/main/agent/agents/run-tools'
import { BrowserTextVault } from '../src/main/agent/browser/browser-text-vault'
import { HostServiceRegistry } from '../src/main/agent/engine/host-service-registry'
import { createRpcDesktopToolScope } from '../src/main/agent/engine/rpc/desktop-tool-scope'
import { registeredHostTools } from '../src/main/agent/engine/rpc/host-tool-validation'
import { executionRoster } from '../src/main/agent/engine/phi-extension/lib/rpc-execution-protocol'
import { appRpcDesktopToolNames } from '../src/main/agent/remote-session-routing'

const forbiddenToolName = /credential|bootstrap|password|passphrase|settings?/iu

function extensionSources(directory: URL): string {
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const url = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, directory)
      return entry.isDirectory()
        ? [extensionSources(url)]
        : entry.name.endsWith('.ts')
          ? [readFileSync(url, 'utf8')]
          : []
    })
    .join('\n')
}

test('SSH password bootstrap is absent from every agent-visible local and RPC registry', () => {
  const runToolNames = buildAgentRunTools(new AgentRunRegistry()).map((tool) => tool.name)
  const inProcessDir = new URL('../src/main/agent/engine/in-process/', import.meta.url)
  const workerSource = [
    readFileSync(new URL('../src/main/agent/engine/events.ts', import.meta.url), 'utf8'),
    ...readdirSync(inProcessDir)
      .filter((name) => name.endsWith('.ts'))
      .sort()
      .map((name) => readFileSync(new URL(name, inProcessDir), 'utf8'))
  ].join('\n')

  assert.deepEqual(runToolNames, ['agent_status', 'agent_wait', 'agent_steer', 'agent_stop'])
  assert.doesNotMatch(workerSource, /ssh[_-]?bootstrap|password[_-]?bootstrap/iu)

  const scope = createRpcDesktopToolScope({
    identity: {
      runtimeSessionId: 'runtime-session',
      sessionId: 'phi-session',
      projectId: 'project',
      cwd: '/server/project'
    },
    services: new HostServiceRegistry(),
    currentRun: () => undefined,
    recentUserImages: () => [],
    allowBrowserTypeText: () => false,
    browserTextVault: new BrowserTextVault(),
    agentDir: '/desktop/profile',
    allowedSkills: [],
    scriptTools: []
  })
  try {
    const advertised = appRpcDesktopToolNames()
    const published = [...registeredHostTools(scope.tools).keys()]
    assert.equal(
      advertised.some((name) => forbiddenToolName.test(name)),
      false
    )
    assert.equal(
      published.some((name) => forbiddenToolName.test(name)),
      false
    )
  } finally {
    scope.dispose()
  }
})

test('RPC desktop and server roster gates reject credential or host-setup tool names', () => {
  for (const name of [
    'credential_helper',
    'ssh_bootstrap',
    'password_reset',
    'passphrase_prompt',
    'remote_settings'
  ]) {
    assert.throws(
      () =>
        executionRoster([
          { name: 'read', site: 'native' },
          { name, site: 'host', parameters: { type: 'object' } }
        ]),
      /Invalid execution roster/
    )
  }

  assert.throws(
    () =>
      appRpcDesktopToolNames({
        allowedSkills: ['unsafe'],
        scriptTools: [
          {
            name: 'password_reset',
            description: 'unsafe',
            parameters: { type: 'object' },
            attachTo: ['main'],
            skill: 'unsafe',
            approval: 'read'
          }
        ]
      } as never),
    /cannot expose credential or host-setup/
  )

  const source = extensionSources(
    new URL('../src/main/agent/engine/phi-extension/', import.meta.url)
  )
  const literalToolNames = [...source.matchAll(/\bname\s*:\s*['"`]([^'"`]+)['"`]/gu)].map(
    (match) => match[1]
  )
  assert.equal(
    literalToolNames.some((name) => forbiddenToolName.test(name)),
    false
  )
})
