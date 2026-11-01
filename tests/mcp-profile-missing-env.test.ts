import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { resolveBunExecutable } from '../src/main/agent/engine/bun-executable'

const NAME = 'a managed MCP server whose environment is missing is skipped, not fatal'

if ('Bun' in globalThis) {
  test(NAME, async () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'phi-mcp-missing-env-'))
    // MCP discovery reads the user profile from the SDK agent dir.
    process.env.PI_CODING_AGENT_DIR = agentDir
    const { AuthStorage, Settings } = await import('@oh-my-pi/pi-coding-agent')
    const { leasedProfileMcpManager } =
      await import('../src/main/agent/engine/in-process/mcp-profile')
    const cwd = mkdtempSync(join(tmpdir(), 'phi-mcp-missing-env-project-'))
    try {
      // No <agentDir>/runtime at all: the environment the marker names cannot exist.
      writeFileSync(
        join(agentDir, 'mcp.json'),
        JSON.stringify({
          mcpServers: {
            biomcp: {
              type: 'stdio',
              command: '/usr/bin/env',
              args: ['-i', 'true'],
              env: {},
              phiManaged: {
                version: 1,
                ref: 'phi:python@1',
                effectiveRef: 'phi:python@1',
                envId: 'phi-python-fd8517e91245',
                command: 'python',
                args: []
              }
            }
          }
        })
      )
      const authStorage = await AuthStorage.create(join(agentDir, 'agent.db'))
      const leased = await leasedProfileMcpManager(agentDir, cwd, Settings.isolated(), authStorage)
      assert.deepEqual(leased.skipped, [{ name: 'biomcp', reason: 'env_not_ready' }])
      assert.equal(leased.leases.size, 0)
      assert.equal(leased.snapshot.configs.biomcp, undefined)
    } finally {
      rmSync(agentDir, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
    }
  })
} else {
  test(NAME, () => {
    execFileSync(
      resolveBunExecutable(),
      ['test', '--timeout', '60000', fileURLToPath(import.meta.url)],
      {
        cwd: resolve('.'),
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
  })
}
