import assert from 'node:assert/strict'

import type { KernelProtocolClient } from '../../src/main/agent/engine/kernel-client'
import {
  reattachRemoteKernel,
  type LaunchedRemoteKernel,
  type ReattachedRemoteKernel
} from '../../src/main/agent/engine/kernel-client/remote'
import type {
  RemoteReverseTunnel,
  RemoteSshSession
} from '../../src/main/agent/wrappers/remote-ssh-session'
import { bounded, MODEL_DESCRIPTOR, type ScenarioClient } from './harness'
import { KERNEL_E2E_HOST_CAPABILITIES } from './lifecycle-scenarios'

interface ModelProxyReportProjection {
  readonly deploy: { reattachRemoteCommandCount?: number }
  readonly evidence: {
    initialModelProxyPort?: number
    reconnectedModelProxyPort?: number
    modelProxyRequestAttempts?: number
    modelProxyCompletedRequests?: number
  }
}

type Step = <T>(name: string, action: () => Promise<T>) => Promise<T>

function endpoint(tunnel: RemoteReverseTunnel): string {
  return `http://127.0.0.1:${tunnel.remotePort}/v1/pi/stream`
}

async function configureModelProxy(
  client: KernelProtocolClient,
  tunnel: RemoteReverseTunnel,
  bearerToken: string
): Promise<void> {
  await bounded(
    client.request('modelAccess.configure', {
      endpoint: endpoint(tunnel),
      bearerToken,
      models: [
        {
          provider: MODEL_DESCRIPTOR.provider,
          id: MODEL_DESCRIPTOR.id,
          name: MODEL_DESCRIPTOR.name,
          reasoning: MODEL_DESCRIPTOR.reasoning,
          input: [...MODEL_DESCRIPTOR.input],
          contextWindow: MODEL_DESCRIPTOR.contextWindow,
          maxTokens: MODEL_DESCRIPTOR.maxTokens,
          ...(MODEL_DESCRIPTOR.cost ? { cost: { ...MODEL_DESCRIPTOR.cost } } : {})
        }
      ]
    }),
    'modelAccess.configure'
  )
}

export async function configureInitialModelProxy(options: {
  client: KernelProtocolClient
  tunnel: RemoteReverseTunnel
  bearerToken: string
  report: ModelProxyReportProjection
  step: Step
}): Promise<void> {
  options.report.evidence.initialModelProxyPort = options.tunnel.remotePort
  await options.step('initial model proxy configured after kernel hello', () =>
    configureModelProxy(options.client, options.tunnel, options.bearerToken)
  )
}

export async function runSshModelProxyReconnectScenario<T extends ScenarioClient>(options: {
  session: Pick<RemoteSshSession, 'openStdio' | 'openReverseTunnel'>
  launch: LaunchedRemoteKernel
  initialTunnel: RemoteReverseTunnel
  client: T
  createClient(client: KernelProtocolClient): T
  provider: {
    readonly port: number
    readonly requests: readonly unknown[]
    enqueue(...replies: Array<{ text: string }>): void
    holdNextRequestBeforeResponse(): Promise<void>
    dropActiveConnections(): void
    completedRequestCount(): number
  }
  files: { readonly paths: { readonly projectA: string } }
  bearerToken: string
  report: ModelProxyReportProjection
  step: Step
  onDiagnostic(text: string): void
}): Promise<{
  remoteLaunch: LaunchedRemoteKernel
  scenario: T
  tunnel: RemoteReverseTunnel
}> {
  let scenario = options.client
  const sessionId = await options.step('model proxy reconnect session created', () =>
    scenario.create(options.files.paths.projectA, false)
  )
  assert.equal(options.provider.requests.length, 0)

  // The SSH master allows one reverse tunnel per local gateway, so the replacement is
  // opened only after the initial tunnel is dropped, as after a real reconnect.
  const openReplacementTunnel = async (): Promise<RemoteReverseTunnel> => {
    if (!options.session.openReverseTunnel) {
      throw new Error('Connected SSH session cannot forward the replacement model proxy')
    }
    let tunnel = await options.session.openReverseTunnel({ localPort: options.provider.port })
    if (tunnel.remotePort === options.initialTunnel.remotePort) {
      // A reused port would not prove the endpoint switch; ask for another one once.
      await tunnel.close()
      tunnel = await options.session.openReverseTunnel({ localPort: options.provider.port })
    }
    assert.notEqual(tunnel.remotePort, options.initialTunnel.remotePort)
    return tunnel
  }
  let replacementTunnel: RemoteReverseTunnel | undefined
  let reattached: ReattachedRemoteKernel | undefined
  let resumedScenario: T | undefined

  try {
    const heldRequest = options.provider.holdNextRequestBeforeResponse()
    options.provider.enqueue({ text: 'MODEL_PROXY_RECONNECTED' })
    const runId = await options.step('model-dependent run accepted before proxy disconnect', () =>
      scenario.startPrompt(sessionId, 'Complete this turn through the model proxy after reconnect.')
    )
    await options.step('initial model request held before any response byte', () =>
      bounded(heldRequest, 'initial model request before response')
    )
    assert.equal(scenario.hasCompleted(runId), false)
    const lastSeen = scenario.lastSeen
    scenario.close()
    await options.step(
      'controller, initial tunnel, and held model connection dropped with the run pending',
      async () => {
        await options.launch.close()
        await options.initialTunnel.close()
        options.provider.dropActiveConnections()
      }
    )
    const tunnel = await options.step(
      'replacement model proxy tunnel allocated on a different remote port',
      openReplacementTunnel
    )
    replacementTunnel = tunnel
    options.report.evidence.reconnectedModelProxyPort = tunnel.remotePort

    reattached = await options.step('remote kernel reattached with takeover and replay', () =>
      reattachRemoteKernel({
        session: options.session,
        previous: options.launch,
        lastSeen,
        signal: AbortSignal.timeout(60_000),
        hello: { hostCapabilities: [...KERNEL_E2E_HOST_CAPABILITIES] },
        configureClient(client) {
          resumedScenario = options.createClient(client)
        },
        onDiagnostic: options.onDiagnostic
      })
    )
    assert.equal(reattached.snapshotRequired, false)
    assert.equal(reattached.attach.state, 'attached')
    assert.equal(reattached.greeting.kernelInstanceId, options.launch.greeting.kernelInstanceId)
    options.report.deploy.reattachRemoteCommandCount = reattached.remoteCommandCount
    if (!resumedScenario) throw new Error('Reconnect did not configure the scenario client')
    scenario = resumedScenario
    const activeLaunch = reattached

    await options.step('replacement model proxy configured after kernel reattach', () =>
      configureModelProxy(activeLaunch.client, tunnel, options.bearerToken)
    )
    await options.step(
      'same model-dependent run completed through the replacement tunnel',
      async () => {
        const completion = await scenario.waitForRun(runId)
        assert.equal(completion.status, 'completed', completion.detail)
        assert.match(JSON.stringify(await scenario.snapshot(sessionId)), /MODEL_PROXY_RECONNECTED/)
        assert.equal(options.provider.requests.length, 2)
        assert.equal(options.provider.completedRequestCount(), 1)
        options.report.evidence.modelProxyRequestAttempts = options.provider.requests.length
        options.report.evidence.modelProxyCompletedRequests =
          options.provider.completedRequestCount()
      }
    )
    return { remoteLaunch: activeLaunch, scenario, tunnel }
  } catch (error) {
    resumedScenario?.close()
    await reattached?.close().catch(() => undefined)
    await replacementTunnel?.close().catch(() => undefined)
    throw error
  }
}
