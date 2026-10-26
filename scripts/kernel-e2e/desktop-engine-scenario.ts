import assert from 'node:assert/strict'

import type { KernelSessionFactory } from '../../src/main/agent/engine/kernel-session-factory'
import type { KernelRoutedSessionDriver } from '../../src/main/agent/engine/kernel-routed-session-driver'
import type { PhiSessionCreateParams } from '../../src/main/agent/engine/types'
import { MODEL_ID, PROVIDER_ID, type startLoopbackProvider } from './harness'

export async function runDesktopEngineScenario(input: {
  factory: KernelSessionFactory
  provider: Awaited<ReturnType<typeof startLoopbackProvider>>
  projectRoot: string
  writtenFile: string
  exists(path: string): Promise<boolean>
  read(path: string): Promise<string>
  disconnect(): Promise<void>
}): Promise<{ approvals: number; reattached: true }> {
  const active: { driver?: KernelRoutedSessionDriver } = {}
  let approvals = 0
  const params: PhiSessionCreateParams = {
    sessionId: 'desktop-engine-runtime',
    cwd: input.projectRoot,
    agentDir: '/desktop/kernel-agent',
    model: {
      provider: PROVIDER_ID,
      id: MODEL_ID,
      name: 'Desktop engine scripted model',
      reasoning: false
    },
    sessionManager: { kind: 'persistent', cwd: input.projectRoot },
    enableToolApproval: true,
    workMode: 'direct',
    autoCompaction: { enabled: false },
    resourceOptions: {
      noExtensions: true,
      noSkills: true,
      noContextFiles: true,
      noPromptTemplates: true,
      noThemes: true
    },
    remoteProject: {
      phiSessionId: 'desktop-engine-phi',
      projectId: 'desktop-engine-project',
      location: {
        kind: 'ssh',
        hostProfileId: 'ssh-config:desktop-engine',
        remoteRoot: input.projectRoot,
        canonicalRoot: input.projectRoot
      },
      contextFiles: []
    }
  }
  const routed = await input.factory.create(params, new AbortController().signal, {
    event: () => undefined,
    state: () => undefined,
    approval: (request) => {
      const approval = request as { requestId?: unknown }
      if (typeof approval.requestId !== 'string') return
      approvals += 1
      void active.driver?.respondToolApproval(approval.requestId, null)
    }
  })
  const driver = routed as KernelRoutedSessionDriver
  active.driver = driver

  input.provider.enqueue(
    {
      tool: {
        name: 'write',
        id: 'desktop-engine-write',
        args: { path: input.writtenFile, content: 'DESKTOP_ENGINE_APPROVED\n' }
      }
    },
    { text: 'DESKTOP_ENGINE_APPROVAL_COMPLETE' }
  )
  await driver.prompt('Write the approved desktop-engine marker.', {
    hostRunId: 'desktop-engine-approval'
  })
  assert.equal(approvals, 1)
  assert.equal(await input.read(input.writtenFile), 'DESKTOP_ENGINE_APPROVED\n')

  const held = input.provider.holdNextRequestBeforeResponse()
  input.provider.enqueue({ text: 'DESKTOP_ENGINE_REATTACHED' })
  const continuing = driver.prompt('Continue across one controller disconnect.', {
    hostRunId: 'desktop-engine-reconnect'
  })
  await held
  await input.disconnect()
  input.provider.dropActiveConnections()
  const state = await continuing
  assert.match(JSON.stringify(state.messages), /DESKTOP_ENGINE_REATTACHED/u)
  assert.equal(await input.exists(input.writtenFile), true)
  await driver.dispose()
  return { approvals, reattached: true }
}
